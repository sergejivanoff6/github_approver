#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";
import { Octokit } from "@octokit/rest";
import YAML from "yaml";
import semver from "semver";

// Utility function to get formatted timestamp
function getTimestamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

// Override console.log to include timestamps
const originalLog = console.log;
console.log = (...args) => {
  originalLog(`[${getTimestamp()}]`, ...args);
};

const originalError = console.error;
console.error = (...args) => {
  originalError(`[${getTimestamp()}]`, ...args);
};

const originalWarn = console.warn;
console.warn = (...args) => {
  originalWarn(`[${getTimestamp()}]`, ...args);
};

// Paths to your text files
const TOKEN_FILE = "token.txt";
const REPOS_FILE = "repos.txt";

// Switches
//   --dry-run     : log every decision, never write (no update-branch, no approve, no merge)
//   --no-merge    : old behaviour, approve only
//   MERGE_METHOD  : "squash" (default) | "merge" | "rebase"
const DRY_RUN =
  process.argv.includes("--dry-run") || process.env.DRY_RUN === "1";
const MERGE_ENABLED =
  !process.argv.includes("--no-merge") && process.env.NO_MERGE !== "1";
const MERGE_METHOD = (process.env.MERGE_METHOD || "squash").toLowerCase();

const DEPENDABOT_LOGIN = "dependabot[bot]";

// 1. Read GitHub token from file
let GITHUB_TOKEN;
try {
  GITHUB_TOKEN = fs.readFileSync(TOKEN_FILE, "utf-8").trim();
  if (!GITHUB_TOKEN) {
    throw new Error("Token file is empty");
  }
} catch (err) {
  console.error(`Error reading token from "${TOKEN_FILE}": ${err.message}`);
  process.exit(1);
}

// 2. Read repository list from file
let repos;
try {
  repos = fs
    .readFileSync(REPOS_FILE, "utf-8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean); // remove empty lines

  if (repos.length === 0) {
    throw new Error("No valid repos found in file");
  }
} catch (err) {
  console.error(
    `Error reading repositories from "${REPOS_FILE}": ${err.message}`,
  );
  process.exit(1);
}

// 3. Create an authenticated Octokit client
const octokit = new Octokit({ auth: GITHUB_TOKEN });

/**
 * Check if a given pull request is "green" by looking at its check runs.
 * If all check runs have a conclusion of "success", we consider it green.
 */
async function isPullRequestGreen(owner, repo, pr) {
  try {
    const { data } = await octokit.repos.getCombinedStatusForRef({
      owner,
      repo,
      ref: pr.head.sha,
    });

    // data.state can be "success", "failure", "error", "pending", or "neutral"
    return data.state === "success";
  } catch (error) {
    console.error(
      `    Error fetching check runs for PR #${pr.number}: ${error.message}`,
    );
    // If we can't fetch checks, fail safe and consider it not green
    return false;
  }
}

/**
 * If the pull request’s head branch is behind the base (usually `master`/`main`),
 * tell GitHub to merge the base into the head.
 *
 * Returns true if we triggered an update, false otherwise.
 */
async function syncBranchIfBehind(owner, repo, pr) {
  // Treat both states as potentially out-of-date
  const outdatedStates = ["behind", "blocked"];

  if (!outdatedStates.includes(pr.mergeable_state)) {
    return false; // nothing to do
  }

  console.log(
    `    PR #${pr.number} is ${pr.mergeable_state}. Queuing update-branch…`,
  );

  if (DRY_RUN) {
    console.log("      [dry-run] would queue update-branch");
    return true;
  }

  try {
    // PUT /repos/{owner}/{repo}/pulls/{pull_number}/update-branch
    await octokit.request(
      "PUT /repos/{owner}/{repo}/pulls/{pull_number}/update-branch",
      {
        owner,
        repo,
        pull_number: pr.number,
        expected_head_sha: pr.head.sha, // fail fast if someone pushed meanwhile
      },
    );

    console.log("      ➜ update-branch request queued");
    return true; // we triggered a sync
  } catch (err) {
    // 422 “Branch was not updated” === already up-to-date or conflicts
    if (err.status === 422) {
      console.log(`      update-branch skipped: ${err.message}`);
    } else {
      console.error(
        `      ✖ couldn’t update branch: ${err.message || err.toString()}`,
      );
    }
    return false;
  }
}

/**
 * The token owner’s login, fetched once and reused.
 */
let cachedLogin = null;
async function getAuthenticatedLogin() {
  if (!cachedLogin) {
    const { data } = await octokit.rest.users.getAuthenticated();
    cachedLogin = data.login;
  }
  return cachedLogin;
}

/**
 * Collapse a PR’s review history into the *latest* verdict per reviewer.
 * COMMENTED / PENDING reviews don’t change anyone’s verdict; a DISMISSED
 * approval stops counting as an approval.
 */
async function getReviewState(owner, repo, pullNumber) {
  const reviews = await octokit.paginate(octokit.pulls.listReviews, {
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100,
  });

  const latestByReviewer = new Map(); // reviews come back in chronological order
  for (const review of reviews) {
    const login = review.user?.login;
    if (!login) continue;
    if (!["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state)) {
      continue;
    }
    latestByReviewer.set(login, review.state);
  }

  const approvedBy = [];
  const changesRequestedBy = [];
  for (const [login, state] of latestByReviewer) {
    if (state === "APPROVED") approvedBy.push(login);
    if (state === "CHANGES_REQUESTED") changesRequestedBy.push(login);
  }

  return { approvedBy, changesRequestedBy };
}

async function approvePullRequest(owner, repo, pullNumber, reviewState, myLogin) {
  if (reviewState.approvedBy.includes(myLogin)) {
    console.log(`      Already approved by ${myLogin}. Skipping...`);
    return;
  }

  if (DRY_RUN) {
    console.log(`      [dry-run] would approve as ${myLogin}.`);
    return;
  }

  await octokit.pulls.createReview({
    owner,
    repo,
    pull_number: pullNumber,
    event: "APPROVE",
    body: "", // empty string => no comment
  });
  console.log(`      Approved by ${myLogin}.`);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Security-update detection
 *
 * Mirrors dependabot/fetch-metadata (src/dependabot/verified_commits.ts →
 * getAlert()), GitHub’s own reference implementation for this gate:
 *
 *   1. every Dependabot commit carries a hidden YAML block in its commit
 *      message listing `updated-dependencies` (name + new version);
 *   2. each updated dependency is cross-referenced against the repo’s *open*
 *      Dependabot alerts — an open alert for that package whose
 *      `first_patched_version` the PR’s new version satisfies means the PR is
 *      a security fix.
 *
 * Every unknown (unparseable version, missing metadata, unreadable alerts)
 * resolves to "not a security update", i.e. the PR is left unmerged.
 * ──────────────────────────────────────────────────────────────────────────── */

function normalizeDir(dir) {
  const trimmed = String(dir || "").replace(/^\/+|\/+$/g, "");
  return trimmed ? `/${trimmed}` : "/";
}

function splitVersion(version) {
  if (typeof version !== "string") return null;
  const cleaned = version.trim().replace(/^[v=\s]+/i, "").split("+")[0];
  if (!cleaned) return null;
  const dash = cleaned.indexOf("-");
  const core = dash === -1 ? cleaned : cleaned.slice(0, dash);
  const pre = dash === -1 ? "" : cleaned.slice(dash + 1);
  const numbers = core.split(".");
  if (!numbers.length || !numbers.every((n) => /^\d+$/.test(n))) return null;
  return { numbers: numbers.map(Number), pre };
}

/**
 * Returns 1 / 0 / -1, or null when the versions can’t be compared safely.
 *
 * Proper semver (the npm case) goes through `semver`, which orders
 * pre-releases correctly. Everything else — Maven's "2.0.0.Final", NuGet's
 * 4-part versions, 2-part versions — falls back to a plain numeric compare,
 * because semver.compare() *throws* on those. Never `semver.coerce()`: it
 * turns "4.5.1.2" into "4.5.1" and would call 4.5.1.2 a fix for 4.5.1.1.
 */
function compareVersions(a, b) {
  if (semver.valid(a) && semver.valid(b)) {
    return semver.compare(a, b);
  }

  const va = splitVersion(a);
  const vb = splitVersion(b);
  if (!va || !vb) return null;

  const length = Math.max(va.numbers.length, vb.numbers.length);
  for (let i = 0; i < length; i++) {
    const x = va.numbers[i] ?? 0;
    const y = vb.numbers[i] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }

  if (!va.pre && !vb.pre) return 0;
  return null; // non-semver pre-release ordering is ecosystem-specific
}

/**
 * Pull the `updated-dependencies:` list out of the hidden YAML block that
 * Dependabot appends to every commit message (between `---` and `...`).
 *
 * A commit body may contain other `---` separators, so every candidate block
 * is tried and the first one that actually holds the list wins. Parsed with
 * the `failsafe` schema so versions stay strings — the default schema reads
 * `dependency-version: 1.10` as the number 1.1.
 */
function parseUpdatedDependencies(commitMessage) {
  const lines = String(commitMessage || "").split(/\r?\n/);

  for (let start = 0; start < lines.length; start++) {
    if (lines[start].trim() !== "---") continue;

    let end = start + 1;
    while (end < lines.length && !["...", "---"].includes(lines[end].trim())) {
      end++;
    }

    let parsed;
    try {
      parsed = YAML.parse(lines.slice(start + 1, end).join("\n"), {
        schema: "failsafe",
      });
    } catch {
      continue; // not the metadata block, or malformed — keep looking
    }

    const updated = parsed?.["updated-dependencies"];
    if (!Array.isArray(updated)) continue;

    return updated
      .filter((entry) => entry && entry["dependency-name"])
      .map((entry) => ({
        name: String(entry["dependency-name"]),
        version:
          entry["dependency-version"] != null
            ? String(entry["dependency-version"])
            : null,
        type: entry["dependency-type"] ?? null,
        updateType: entry["update-type"] ?? null,
      }));
  }

  return [];
}

/**
 * Older Dependabot commits have no `dependency-version:` key — fall back to the
 * human-readable "Bumps <name> from X to Y" line.
 */
function versionFromCommitMessage(commitMessage, dependencyName) {
  if (!dependencyName) return null;
  const escaped = dependencyName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `(?:Bumps|Updates)\\s+\\[?\`?${escaped}\`?\\]?(?:\\([^)]*\\))?\\s+from\\s+\\S+\\s+to\\s+(\\S+)`,
    "i",
  );
  const match = re.exec(String(commitMessage || ""));
  return match ? match[1].replace(/[.,;:]+$/, "") : null;
}

/**
 * Work out the manifest directory from the branch name
 * (`dependabot/<ecosystem>/<directory>/<name>-<version>`). The dependency name
 * itself may contain slashes (`@babel/core`, `github.com/foo/bar`), so the
 * known name+version is used to find where the directory ends.
 * Returns null when the shape is unexpected (e.g. grouped updates) — the
 * directory check is then skipped.
 */
function directoryFromBranch(branchName, dependencies) {
  const match = /^dependabot\/[^/]+\/(.*)$/.exec(branchName || "");
  if (!match) return null;
  const remainder = match[1];

  for (const dep of dependencies) {
    if (!dep.name || !dep.version) continue;
    const leaf = `${dep.name.replace(/^@/, "")}-${dep.version}`;
    if (remainder === leaf) return "/";
    if (remainder.endsWith(`/${leaf}`)) {
      return normalizeDir(remainder.slice(0, remainder.length - leaf.length - 1));
    }
  }
  return null;
}

/**
 * Read the PR’s commits and confirm they really come from Dependabot:
 * the first commit must be authored by dependabot[bot] *and* carry a verified
 * signature (same anti-spoofing check fetch-metadata performs), otherwise the
 * `updated-dependencies` block is just attacker-writable text.
 */
async function getVerifiedDependabotMetadata(owner, repo, pr) {
  const commits = await octokit.paginate(octokit.pulls.listCommits, {
    owner,
    repo,
    pull_number: pr.number,
    per_page: 100,
  });

  const isTrusted = (commit) =>
    commit.author?.login === DEPENDABOT_LOGIN &&
    commit.commit?.verification?.verified === true;

  if (commits.length === 0 || !isTrusted(commits[0])) {
    return { verified: false, dependencies: [] };
  }

  const dependencies = [];
  for (const commit of commits.filter(isTrusted)) {
    for (const dep of parseUpdatedDependencies(commit.commit.message)) {
      if (!dep.version) {
        dep.version = versionFromCommitMessage(commit.commit.message, dep.name);
      }
      const known = dependencies.some(
        (d) => d.name === dep.name && d.version === dep.version,
      );
      if (!known) dependencies.push(dep);
    }
  }

  return { verified: true, dependencies };
}

// Open Dependabot alerts, fetched once per repository (null = unavailable)
const alertsCache = new Map();

async function getOpenDependabotAlerts(owner, repo) {
  const key = `${owner}/${repo}`;
  if (alertsCache.has(key)) return alertsCache.get(key);

  let alerts = null;
  try {
    alerts = await octokit.paginate(
      "GET /repos/{owner}/{repo}/dependabot/alerts",
      { owner, repo, state: "open", per_page: 100 },
    );
    console.log(`    ${alerts.length} open Dependabot alert(s) in this repo.`);
  } catch (err) {
    if (err.status === 403) {
      console.warn(
        `    ⚠️  Can’t read Dependabot alerts (token needs 'repo'/'security_events' scope + SSO): ${err.message}`,
      );
    } else if (err.status === 404) {
      console.warn("    ⚠️  Dependabot alerts are disabled for this repository.");
    } else {
      console.error(`    ✖ couldn’t read Dependabot alerts: ${err.message}`);
    }
    alerts = null;
  }

  alertsCache.set(key, alerts);
  return alerts;
}

/**
 * Does any updated dependency close an open alert? → the PR is a security fix.
 */
function findSecurityFix(alerts, dependencies, directory) {
  for (const dep of dependencies) {
    if (!dep.name || !dep.version) continue;

    for (const alert of alerts) {
      const alertName = alert?.dependency?.package?.name;
      const patched =
        alert?.security_vulnerability?.first_patched_version?.identifier;
      if (!alertName || !patched) continue;
      if (alertName.toLowerCase() !== dep.name.toLowerCase()) continue;

      const cmp = compareVersions(dep.version, patched);
      if (cmp === null || cmp < 0) continue; // new version doesn’t reach the fix

      const manifest = alert?.dependency?.manifest_path;
      if (directory && manifest) {
        if (normalizeDir(manifest.replace(/[^/]*$/, "")) !== directory) continue;
      }

      return {
        dependency: dep,
        patched,
        ghsaId: alert.security_advisory?.ghsa_id || null,
        severity:
          alert.security_advisory?.severity ||
          alert.security_vulnerability?.severity ||
          "unknown",
      };
    }
  }
  return null;
}

/**
 * Merge the PR, re-reading its state first so we don’t merge something that
 * moved under us. Returns "merged" | "skipped" | "failed".
 */
async function mergePullRequest(owner, repo, pr) {
  const { data: fresh } = await octokit.pulls.get({
    owner,
    repo,
    pull_number: pr.number,
  });

  if (fresh.merged) {
    console.log(`    PR #${pr.number} is already merged.`);
    return "skipped";
  }
  if (fresh.draft) {
    console.log(`    PR #${pr.number} is a draft. Not merging.`);
    return "skipped";
  }
  if (fresh.head.sha !== pr.head.sha) {
    console.log(
      `    PR #${pr.number} head moved while we were checking. Next run.`,
    );
    return "skipped";
  }
  // "clean" = good to go, "has_hooks" = same + pre-receive hooks,
  // "unstable" = only non-required checks are red
  if (fresh.mergeable === false || !["clean", "has_hooks", "unstable"].includes(fresh.mergeable_state)) {
    console.log(
      `    PR #${pr.number} mergeable_state="${fresh.mergeable_state}". Not merging.`,
    );
    return "skipped";
  }

  if (DRY_RUN) {
    console.log(`    [dry-run] would merge PR #${pr.number} (${MERGE_METHOD}).`);
    return "skipped";
  }

  try {
    await octokit.pulls.merge({
      owner,
      repo,
      pull_number: pr.number,
      sha: fresh.head.sha, // abort if someone pushes in the meantime
      merge_method: MERGE_METHOD,
    });
    return "merged";
  } catch (err) {
    if (err.status === 405) {
      console.error(
        `    ✖ merge refused (is "${MERGE_METHOD}" allowed in this repo? branch protection?): ${err.message}`,
      );
    } else if (err.status === 409) {
      console.error(`    ✖ head SHA changed, retrying next run: ${err.message}`);
    } else {
      console.error(`    ✖ merge failed: ${err.message}`);
    }
    return "failed";
  }
}

/**
 * Auto-merge gate. All four conditions must hold:
 *   1. it’s a Dependabot PR (caller filtered) with verified dependabot[bot] commits
 *   2. CI is green (caller checked)
 *   3. at least one approval from another person, no outstanding change requests
 *   4. it fixes an open Dependabot alert (security update)
 *
 * Returns { status: "merged" | "skipped" | "failed", summary }.
 */
async function autoMergeIfSecurityFix(owner, repo, pr, reviewState, myLogin) {
  // 3. approval by another person
  const otherApprovers = reviewState.approvedBy.filter(
    (login) => login !== myLogin && !login.endsWith("[bot]"),
  );
  if (otherApprovers.length === 0) {
    console.log("    No approval from another person yet. Not merging.");
    return { status: "skipped" };
  }
  if (reviewState.changesRequestedBy.length > 0) {
    console.log(
      `    Changes requested by ${reviewState.changesRequestedBy.join(", ")}. Not merging.`,
    );
    return { status: "skipped" };
  }

  // 1. commits genuinely signed by Dependabot
  const { verified, dependencies } = await getVerifiedDependabotMetadata(
    owner,
    repo,
    pr,
  );
  if (!verified) {
    console.log(
      "    First commit isn’t a verified dependabot[bot] commit. Not merging.",
    );
    return { status: "skipped" };
  }
  if (dependencies.length === 0) {
    console.log(
      "    No 'updated-dependencies' metadata in the commit message. Not merging.",
    );
    return { status: "skipped" };
  }

  // 4. cross-reference against open Dependabot alerts
  const alerts = await getOpenDependabotAlerts(owner, repo);
  if (alerts === null) {
    console.log(
      "    Dependabot alerts unavailable — can’t prove it’s a security update. Not merging.",
    );
    return { status: "skipped" };
  }

  const directory = directoryFromBranch(pr.head.ref, dependencies);
  const hit = findSecurityFix(alerts, dependencies, directory);
  if (!hit) {
    const listed = dependencies
      .map((d) => `${d.name}@${d.version ?? "?"}`)
      .join(", ");
    console.log(`    Not a security update (${listed}). Approve only.`);
    return { status: "skipped" };
  }

  const summary =
    `${hit.dependency.name} → ${hit.dependency.version} ` +
    `(${hit.ghsaId ?? "open alert"}, ${hit.severity})`;

  console.log(
    `    🔐 Security update: ${summary}, first patched ${hit.patched}. ` +
      `Approved by ${otherApprovers.join(", ")}.`,
  );

  const status = await mergePullRequest(owner, repo, pr);
  if (status === "merged") {
    // Grep-friendly marker: `grep -c AUTO-MERGED approve.log`
    console.log(
      `    ✅ AUTO-MERGED ${owner}/${repo}#${pr.number} via ${MERGE_METHOD} — security update: ${summary}`,
    );
  }
  return { status, summary };
}

/**
 * Check if the current token has access to the organization (SAML SSO check)
 */
async function checkSAMLAccess(owner) {
  try {
    // Try to access organization info - this will fail if SAML SSO blocks access
    await octokit.orgs.get({ org: owner });
    return { hasAccess: true, error: null };
  } catch (error) {
    if (error.status === 403) {
      return {
        hasAccess: false,
        error: `SAML SSO: Token not authorized for organization '${owner}'. Please authorize your token at: https://github.com/settings/tokens`,
      };
    }
    if (error.status === 401) {
      return {
        hasAccess: false,
        error: `Authentication failed: Invalid or expired token. Please check your token in ${TOKEN_FILE}`,
      };
    }
    // For other errors, assume we have access and let specific API calls handle it
    return { hasAccess: true, error: null };
  }
}

/**
 * Main function that loops through the repos and approves any eligible Dependabot PRs.
 */
async function main() {
  let stats = {
    approved: 0,
    skipped: 0,
    updated: 0,
    merged: 0,
    merge_failed: 0,
    saml_blocked: 0,
  };

  // Every auto-merged PR, listed in the run summary
  const mergedPRs = [];

  if (DRY_RUN) console.log("🧪 DRY RUN — no approvals, updates or merges will be sent.");
  if (!MERGE_ENABLED) console.log("ℹ️  Auto-merge disabled (--no-merge).");

  const myLogin = await getAuthenticatedLogin();
  console.log(`Authenticated as ${myLogin}.`);

  // Track organizations we've already checked for SAML access
  const orgAccessCache = new Map();

  for (const fullName of repos) {
    const [owner, repo] = fullName.split("/");
    if (!owner || !repo) {
      console.warn(
        `Skipping invalid line in repos file: "${fullName}". Must be "owner/repo".`,
      );
      continue;
    }

    console.log(`\nProcessing repository: ${owner}/${repo}`);

    // Check SAML access for this organization (cached)
    if (!orgAccessCache.has(owner)) {
      console.log(`  Checking SAML SSO access for organization: ${owner}`);
      const accessCheck = await checkSAMLAccess(owner);
      orgAccessCache.set(owner, accessCheck);
    }

    const accessInfo = orgAccessCache.get(owner);
    if (!accessInfo.hasAccess) {
      console.error(`  ❌ ${accessInfo.error}`);
      stats.saml_blocked++;
      continue;
    }

    try {
      // 1. List open PRs
      const { data: pullRequests } = await octokit.pulls.list({
        owner,
        repo,
        state: "open",
      });

      // 2. Filter PRs from Dependabot
      const dependabotPRs = pullRequests.filter((pr) =>
        pr.user?.login?.toLowerCase().includes("dependabot"),
      );

      if (dependabotPRs.length === 0) {
        console.log("  No open Dependabot PRs found.");
        continue;
      }

      // 3. For each Dependabot PR, check if it's green; if so, approve
      for (const pr of dependabotPRs) {
        console.log(`  Found Dependabot PR #${pr.number} -> ${pr.title}`);
        // (A)  ── First, refresh the PR data so we have mergeable_state
        const { data: prDetails } = await octokit.pulls.get({
          owner,
          repo,
          pull_number: pr.number,
        });

        // (B)  ── If it’s behind, trigger the sync
        const updated = await syncBranchIfBehind(owner, repo, prDetails);
        if (updated) {
          stats.updated++;
          // We stop here; CI will re-run. Next cron run of the script will pick it up.
          continue;
        }

        // (C)  ── Now check if the (possibly already-synced) PR is green
        const green = await isPullRequestGreen(owner, repo, pr);
        if (!green) {
          console.log(`    PR #${pr.number} is NOT green. Skipping approval.`);
          stats.skipped++;
          continue;
        }

        // (D)  ── Read the review history once, use it for both steps below
        const reviewState = await getReviewState(owner, repo, pr.number);

        console.log(`    PR #${pr.number} is green! Approving...`);
        await approvePullRequest(owner, repo, pr.number, reviewState, myLogin);
        stats.approved++;

        // (E)  ── Security updates that a human already approved get merged
        if (MERGE_ENABLED) {
          const { status, summary } = await autoMergeIfSecurityFix(
            owner,
            repo,
            pr,
            reviewState,
            myLogin,
          );
          if (status === "merged") {
            stats.merged++;
            mergedPRs.push(`${owner}/${repo}#${pr.number} — ${summary}`);
          }
          if (status === "failed") stats.merge_failed++;
        }
      }
    } catch (err) {
      if (err.status === 403) {
        console.error(`❌ SAML SSO: Access denied to ${owner}/${repo}. Token may need reauthorization.`);
        stats.saml_blocked++;
      } else if (err.status === 401) {
        console.error(`❌ Authentication failed for ${owner}/${repo}. Check your token.`);
        stats.saml_blocked++;
      } else {
        console.error(`Error processing ${owner}/${repo}: ${err.message}`);
        stats.skipped++;
      }
    }
  }

  // Final statistics output
  console.log("\n─────────────────────────────");
  console.log("📊  Summary");
  console.log("─────────────────────────────");

  console.log(`✅ Approved    : ${stats.approved.toString().padStart(3)} PRs`);
  console.log(`⏭️  Skipped     : ${stats.skipped.toString().padStart(3)} PRs`);
  console.log(`🔄 Updated     : ${stats.updated.toString().padStart(3)} PRs`);
  console.log(`🔐 Auto-merged : ${stats.merged.toString().padStart(3)} security PRs`);
  if (stats.merge_failed > 0) {
    console.log(`✖ Merge failed: ${stats.merge_failed.toString().padStart(3)} PRs`);
  }
  if (stats.saml_blocked > 0) {
    console.log(`🔒 SAML Blocked: ${stats.saml_blocked.toString().padStart(3)} repos`);
  }

  console.log("─────────────────────────────");

  if (mergedPRs.length > 0) {
    console.log(`\n🔐 Auto-merged security PRs (${mergedPRs.length}):`);
    for (const line of mergedPRs) {
      console.log(`   • ${line}`);
    }
  }

  if (stats.saml_blocked > 0) {
    console.log("\n🔐 SAML SSO Issue Detected:");
    console.log("   Your token needs authorization for SSO-enabled organizations.");
    console.log("   Visit: https://github.com/settings/tokens");
    console.log("   Find your token and click 'Enable SSO' for affected organizations.\n");
  }
}

// Run main
main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
