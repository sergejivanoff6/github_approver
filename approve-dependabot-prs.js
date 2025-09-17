#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";
import { Octokit } from "@octokit/rest";

// Paths to your text files
const TOKEN_FILE = "token.txt";
const REPOS_FILE = "repos.txt";

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

async function approvePullRequest(owner, repo, pullNumber) {
  // 1. Get the current user’s login (the token owner).
  //    This requires an extra API call once (possibly store it in a global variable).
  const {
    data: { login: currentUserLogin },
  } = await octokit.rest.users.getAuthenticated();

  // 2. List existing reviews on the PR
  const { data: reviews } = await octokit.pulls.listReviews({
    owner,
    repo,
    pull_number: pullNumber,
  });

  // 3. Check if there's already an APPROVED review by this user
  const alreadyApproved = reviews.some(
    (r) => r.user.login === currentUserLogin && r.state === "APPROVED",
  );

  if (alreadyApproved) {
    console.log(`      Already approved by ${currentUserLogin}. Skipping...`);
    return;
  }

  // 4. Otherwise, create the review
  await octokit.pulls.createReview({
    owner,
    repo,
    pull_number: pullNumber,
    event: "APPROVE",
    body: "", // empty string => no comment
  });
  console.log(`      Approved by ${currentUserLogin}.`);
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
    saml_blocked: 0,
  };

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

        console.log(`    PR #${pr.number} is green! Approving...`);
        await approvePullRequest(owner, repo, pr.number);
        stats.approved++;
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
  if (stats.saml_blocked > 0) {
    console.log(`🔒 SAML Blocked: ${stats.saml_blocked.toString().padStart(3)} repos`);
  }

  console.log("─────────────────────────────");
  
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
