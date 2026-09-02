/**
 * Issue key parser — extracts candidate issue keys from text.
 *
 * Matches patterns like PAY-101, DEV-42, PROJ-1234 etc.
 * Pattern: 2-5 uppercase letters, dash, 1+ digits
 *
 * These are CANDIDATES — must be validated against actual projects.
 */

const ISSUE_KEY_PATTERN = /\b([A-Z]{2,10}-\d+)\b/g;

/**
 * Extract all candidate issue keys from a text string.
 * @param {string} text - Commit message, PR title, branch name, etc.
 * @returns {string[]} Unique candidate issue keys found
 */
export function extractIssueKeys(text) {
  if (!text || typeof text !== 'string') return [];

  const matches = text.match(ISSUE_KEY_PATTERN);
  if (!matches) return [];

  // Return unique keys
  return [...new Set(matches)];
}

/**
 * Check if a text contains a specific issue key.
 * @param {string} text
 * @param {string} issueKey - e.g. "PAY-101"
 * @returns {boolean}
 */
export function containsIssueKey(text, issueKey) {
  if (!text || !issueKey) return false;
  const pattern = new RegExp(`\\b${escapeRegex(issueKey)}\\b`, 'i');
  return pattern.test(text);
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
