#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";
import { Octokit } from "@octokit/rest";

const TOKEN_FILE = "token.txt";
const REPOS_FILE = "repos.txt";

// Read GitHub token
let GITHUB_TOKEN;
try {
  GITHUB_TOKEN = fs.readFileSync(TOKEN_FILE, "utf-8").trim();
  if (!GITHUB_TOKEN) {
    throw new Error("Token file is empty");
  }
} catch (err) {
  console.error(`❌ Error reading token from "${TOKEN_FILE}": ${err.message}`);
  process.exit(1);
}

// Read repositories
let repos;
try {
  repos = fs
    .readFileSync(REPOS_FILE, "utf-8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (repos.length === 0) {
    throw new Error("No valid repos found in file");
  }
} catch (err) {
  console.error(`❌ Error reading repositories from "${REPOS_FILE}": ${err.message}`);
  process.exit(1);
}

const octokit = new Octokit({ auth: GITHUB_TOKEN });

async function checkTokenAndAccess() {
  console.log("🔍 Checking GitHub Token Status and SAML SSO Access\n");

  try {
    // Check token validity
    const { data: user } = await octokit.rest.users.getAuthenticated();
    console.log(`✅ Token is valid for user: ${user.login}`);
    console.log(`📧 Email: ${user.email || 'Not public'}`);
    console.log(`🏢 Company: ${user.company || 'Not specified'}`);
    
    // Check token scopes
    const response = await octokit.request('GET /user');
    const scopes = response.headers['x-oauth-scopes'] || '';
    console.log(`🔐 Token scopes: ${scopes || 'Unable to determine'}\n`);

    // Extract unique organizations from repos
    const organizations = [...new Set(repos.map(repo => repo.split('/')[0]))];
    
    console.log("🏢 Checking SAML SSO access for organizations:\n");
    
    let samlIssues = 0;
    
    for (const org of organizations) {
      try {
        await octokit.orgs.get({ org });
        console.log(`  ✅ ${org}: Access granted`);
      } catch (error) {
        if (error.status === 403) {
          console.log(`  ❌ ${org}: SAML SSO authorization required`);
          samlIssues++;
        } else if (error.status === 404) {
          console.log(`  ⚠️  ${org}: Organization not found or no access`);
        } else if (error.status === 401) {
          console.log(`  ❌ ${org}: Token authentication failed`);
          samlIssues++;
        } else {
          console.log(`  ⚠️  ${org}: Error ${error.status}: ${error.message}`);
        }
      }
    }

    console.log("\n" + "=".repeat(50));
    
    if (samlIssues === 0) {
      console.log("🎉 All good! Your token has access to all required organizations.");
    } else {
      console.log(`🔒 Found ${samlIssues} organization(s) requiring SAML SSO authorization.`);
      console.log("\n📋 To fix SAML SSO issues:");
      console.log("1. Go to: https://github.com/settings/tokens");
      console.log("2. Find your Personal Access Token");
      console.log("3. Click 'Enable SSO' next to organizations that require it");
      console.log("4. Complete the SAML authentication process");
      console.log("\n💡 Alternative: Create a fine-grained PAT with better SSO support:");
      console.log("   https://github.com/settings/personal-access-tokens/new");
    }

  } catch (error) {
    console.error(`❌ Fatal error: ${error.message}`);
    if (error.status === 401) {
      console.log("\n💡 Your token appears to be invalid or expired.");
      console.log("   Please check your token in token.txt");
    }
    process.exit(1);
  }
}

// Run the check
checkTokenAndAccess().catch(console.error);