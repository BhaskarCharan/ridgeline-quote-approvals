import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { ConfigurationError } from "../domain/errors.js";
import { ApprovalPolicySchema, type ApprovalPolicy } from "../domain/policy.js";

/**
 * Load and validate the approval policy YAML. Fails fast with every problem
 * listed, so a bad policy edit is caught at startup, never mid-routing.
 */
export async function loadApprovalPolicy(filePath: string): Promise<ApprovalPolicy> {
  let raw: unknown;
  try {
    raw = parse(await readFile(filePath, "utf8"));
  } catch (err: unknown) {
    throw new ConfigurationError("Cannot read approval policy", {
      file: filePath,
      cause: err instanceof Error ? err.message : String(err),
    });
  }

  const result = ApprovalPolicySchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigurationError("Invalid approval policy", {
      file: filePath,
      issues: result.error.issues.map((i) => ({ path: i.path.join("."), problem: i.message })),
    });
  }
  return result.data;
}
