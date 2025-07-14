import { readFileSync } from "fs";
import * as core from "@actions/core";
import { Octokit } from "@octokit/rest";
import { AzureOpenAI } from "openai";
import parseDiff, { Chunk, File } from "parse-diff";
import minimatch from "minimatch";

const GITHUB_TOKEN: string = core.getInput("GITHUB_TOKEN");
const AZURE_OPENAI_ENDPOINT: string = core.getInput("AZURE_OPENAI_ENDPOINT");
const AZURE_OPENAI_API_KEY: string = core.getInput("AZURE_OPENAI_API_KEY");
const AZURE_OPENAI_API_VERSION: string = core.getInput(
  "AZURE_OPENAI_API_VERSION"
);
const AZURE_OPENAI_DEPLOYMENT: string = core.getInput(
  "AZURE_OPENAI_DEPLOYMENT"
);

const octokit = new Octokit({ auth: GITHUB_TOKEN });

const client = new AzureOpenAI({
  endpoint: AZURE_OPENAI_ENDPOINT,
  apiKey: AZURE_OPENAI_API_KEY,
  apiVersion: AZURE_OPENAI_API_VERSION,
  deployment: AZURE_OPENAI_DEPLOYMENT,
});

interface PRDetails {
  owner: string;
  repo: string;
  pull_number: number;
  title: string;
  description: string;
  headSha: string;
}

async function getPRDetails(): Promise<PRDetails> {
  const { repository, number } = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH || "", "utf8")
  );
  const prResponse = await octokit.pulls.get({
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
  });
  return {
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
    title: prResponse.data.title ?? "",
    description: prResponse.data.body ?? "",
    headSha: prResponse.data.head.sha,
  };
}

async function getDiff(
  owner: string,
  repo: string,
  pull_number: number
): Promise<string | null> {
  const response = await octokit.pulls.get({
    owner,
    repo,
    pull_number,
    mediaType: { format: "diff" },
  });
  // @ts-expect-error - response.data is a string
  return response.data;
}

async function getFullFileContent(
  owner: string,
  repo: string,
  path: string,
  ref: string
): Promise<string> {
  const response = await octokit.repos.getContent({
    owner,
    repo,
    path,
    ref,
  });

  if (!("content" in response.data))
    throw new Error(`Missing content for ${path}`);

  const encoded = response.data.content;
  return Buffer.from(encoded, "base64").toString("utf8");
}

async function analyzeCode(
  parsedDiff: File[],
  prDetails: PRDetails
): Promise<Array<{ body: string; path: string; line: number }>> {
  const comments: Array<{ body: string; path: string; line: number }> = [];
  const fileCache: Record<string, string> = {};

  for (const file of parsedDiff) {
    if (file.to === "/dev/null") continue;

    if (!file.to) continue;

    if (!fileCache[file.to]) {
      try {
        fileCache[file.to] = await getFullFileContent(
          prDetails.owner,
          prDetails.repo,
          file.to,
          prDetails.headSha
        );
      } catch (e) {
        console.warn(`Unable to fetch full file content for ${file.to}: ${e}`);
        fileCache[file.to] = "";
      }
    }

    for (const chunk of file.chunks) {
      const prompt = createPrompt(file, chunk, prDetails, fileCache[file.to]);
      const aiResponse = await getAIResponse(prompt);
      if (aiResponse) {
        const newComments = createComment(file, chunk, aiResponse);
        if (newComments) {
          comments.push(...newComments);
        }
      }
    }
  }

  return comments;
}

function createPrompt(
  file: File,
  chunk: Chunk,
  prDetails: PRDetails,
  fullFile: string
): string {
  return `Your task is to review pull requests. Instructions:
- Provide the response in following JSON format:  {"reviews": [{"lineNumber":  <line_number>, "reviewComment": "<review comment>"}]}
- Do not give positive comments or compliments.
- Provide comments and suggestions ONLY if there is something to improve, otherwise "reviews" should be an empty array.
- Write the comment in GitHub Markdown format.
- Use the given description only for the overall context and only comment the code.
- IMPORTANT: NEVER suggest adding comments to the code.

You are reviewing changes in file: ${file.to}

Pull request title: ${prDetails.title}
Pull request description:
---
${prDetails.description}
---

Here is the full content of the file after the changes:
\`\`\`ts
${fullFile}
\`\`\`

And here is the diff to focus on:
\`\`\`diff
${chunk.content}
${chunk.changes
      .map((c: import("parse-diff").Change) => {
        if ("ln" in c && c.ln !== undefined) {
          return `${c.ln} ${c.content}`;
        } else if ("ln2" in c && c.ln2 !== undefined) {
          return `${c.ln2} ${c.content}`;
        } else {
          return c.content;
        }
      })
      .join("\n")}

\`\`\`
`;
}

async function getAIResponse(
  prompt: string
): Promise<Array<{ lineNumber: string; reviewComment: string }> | null> {
  try {
    const response = await client.chat.completions.create({
      model: "", // fill this with your deployed model name
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: prompt }],
    });

    const res = response.choices[0].message?.content?.trim() || "{}";
    return JSON.parse(res).reviews;
  } catch (error) {
    console.error("AI error:", error);
    return null;
  }
}

function createComment(
  file: File,
  chunk: Chunk,
  aiResponses: Array<{ lineNumber: string; reviewComment: string }>
): Array<{ body: string; path: string; line: number }> {
  return aiResponses.flatMap((aiResponse) => {
    if (!file.to) return [];
    return {
      body: aiResponse.reviewComment,
      path: file.to,
      line: Number(aiResponse.lineNumber),
    };
  });
}

async function createReviewComment(
  owner: string,
  repo: string,
  pull_number: number,
  comments: Array<{ body: string; path: string; line: number }>
): Promise<void> {
  await octokit.pulls.createReview({
    owner,
    repo,
    pull_number,
    comments,
    event: "COMMENT",
  });
}

async function main() {
  const prDetails = await getPRDetails();
  const eventData = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8")
  );

  let diff: string | null;
  if (eventData.action === "opened") {
    diff = await getDiff(
      prDetails.owner,
      prDetails.repo,
      prDetails.pull_number
    );
  } else if (eventData.action === "synchronize") {
    const response = await octokit.repos.compareCommits({
      headers: { accept: "application/vnd.github.v3.diff" },
      owner: prDetails.owner,
      repo: prDetails.repo,
      base: eventData.before,
      head: eventData.after,
    });
    diff = String(response.data);
  } else {
    console.log("Unsupported event:", process.env.GITHUB_EVENT_NAME);
    return;
  }

  if (!diff) {
    console.log("No diff found");
    return;
  }

  const parsedDiff = parseDiff(diff);
  const excludePatterns = core
    .getInput("exclude")
    .split(",")
    .map((s) => s.trim());
  const filteredDiff = parsedDiff.filter(
    (file) =>
      !excludePatterns.some((pattern) => minimatch(file.to ?? "", pattern))
  );

  const comments = await analyzeCode(filteredDiff, prDetails);
  if (comments.length > 0) {
    await createReviewComment(
      prDetails.owner,
      prDetails.repo,
      prDetails.pull_number,
      comments
    );
  }
}

main().catch((error) => {
  console.error("Unhandled error:", error);
  process.exit(1);
});
