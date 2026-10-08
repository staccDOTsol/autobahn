#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildRequest,
  loadEvidence,
  proposalFromResponse,
  requestProposal,
  validateConfig,
} from "./propose.mjs";
import { boundedJson, canonical, insist, sha256 } from "./validate.mjs";

try {
  const [
    command,
    configPath,
    evidencePath,
    outputPath,
    responsePath,
    ...extra
  ] = process.argv.slice(2);
  insist(
    ["prepare", "import", "request"].includes(command) &&
      configPath &&
      evidencePath &&
      outputPath &&
      !extra.length &&
      (command === "import" ? Boolean(responsePath) : !responsePath),
    "Usage: node cli.mjs prepare|request CONFIG EVIDENCE OUTPUT; node cli.mjs import CONFIG EVIDENCE OUTPUT RESPONSE",
  );
  const config = validateConfig(
    boundedJson(await readFile(configPath, "utf8"), 16384),
  );
  const evidence = await loadEvidence(path.resolve(evidencePath));
  const request = buildRequest(config, evidence);
  const artifact =
    command === "prepare"
      ? {
          version: 1,
          kind: "inference-request",
          trust: "untrusted",
          requestSha256: sha256(canonical(request)),
          request,
        }
      : command === "import"
        ? proposalFromResponse(
            config,
            evidence,
            await readFile(responsePath, "utf8"),
          )
        : await requestProposal(config, evidence);
  await mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
  await writeFile(outputPath, JSON.stringify(artifact, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  console.log(
    `${artifact.kind}: ${artifact.artifactSha256 ?? artifact.requestSha256}; status=untrusted`,
  );
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Inference proposal failed",
  );
  process.exitCode = 1;
}
