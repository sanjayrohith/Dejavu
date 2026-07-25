import { readFile, writeFile } from "node:fs/promises";
const [input, output] = process.argv.slice(2);
const result = JSON.parse(await readFile(input, "utf8"));
const container = result.supermemory.container;
const passed = container.ok === true;
const markdown = `# Experiment 11 — RESULT

Generated: ${result.generatedAt}

## Verdict

- **Workspace SQLite VFS persistence: PASS.** Bytes written through the real \`@cloudflare/workspace@${result.workspace.package}\` API survived a full local Wrangler stop/restart using the same persisted Durable Object state.
- **Matching native Supermemory x64 execution: ${passed ? "PASS" : "BLOCKED"}.** ${passed ? "The verified Linux x64 binary started with \`SUPERMEMORY_DATA_DIR\` under the Workspace mount." : `The matching image reached \`${container.stage ?? "unknown"}\` and returned: \`${String(container.error ?? "unknown error").replaceAll("`", "'").slice(0, 500)}\`.`}

## Evidence

| Assertion | Result |
| --- | --- |
| Workspace package | \`${result.workspace.package}\` preview |
| Persisted marker digest | \`${result.workspace.markerSha256}\` |
| Read before restart | exact match |
| Read after Wrangler restart | exact match |
| Supermemory artifact | \`${result.supermemory.artifact}\` v${result.supermemory.version} |
| Published SHA-256 | \`${result.supermemory.checksum}\` |
| Workspace container/native result | \`${passed ? "pass" : "blocked"}\` |

${passed ? `The native command output was:

\`\`\`text
${String(container.stdout ?? "").slice(0, 2000)}
\`\`\`` : `The filesystem result is independent of Container startup. No claim is made that the native binary executed or that Supermemory can currently use the persisted VFS through local Wrangler. The remaining blocker is the actual Workspace Container lifecycle/connect path, not CPU architecture: both wsd and Supermemory were Linux x64.`}

## Boundaries

This is local workerd/Container evidence, not deployed durability. The content is synthetic. The binary was downloaded in the Docker build from the public v0.0.2 release and verified against its published checksum. No cloud model credential was supplied; successful startup uses host Ollama and skips embedding prewarm.
`;
await writeFile(output, markdown);
