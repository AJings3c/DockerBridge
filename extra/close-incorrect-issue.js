import github from "@actions/github";

const INVALID_LABEL = "invalid-format";
const COMMENT_MARKER = "<!-- dockerbridge-invalid-format -->";

(async () => {
    try {
        const token = process.env.GITHUB_TOKEN;
        const issueNumber = Number.parseInt(process.env.ISSUE_NUMBER || "", 10);
        const username = process.env.ISSUE_USERNAME;

        if (!token || !Number.isInteger(issueNumber) || issueNumber <= 0 || !username) {
            throw new Error("Missing or invalid GitHub issue workflow context.");
        }

        const octokit = github.getOctokit(token);
        const client = octokit.rest;

        const issue = {
            ...github.context.repo,
            number: issueNumber,
        };

        const labels = (
            await client.issues.listLabelsOnIssue({
                owner: issue.owner,
                repo: issue.repo,
                issue_number: issue.number
            })
        ).data.map(({ name }) => name);

        // The invalid-format label can be left behind when an earlier run failed
        // after labeling. Treat any other label as evidence that the issue is valid.
        const hasValidLabel = labels.some((name) => name.toLowerCase() !== INVALID_LABEL);

        if (!hasValidLabel) {
            console.log("Bad format here");

            try {
                await client.issues.getLabel({
                    owner: issue.owner,
                    repo: issue.repo,
                    name: INVALID_LABEL,
                });
            } catch (error) {
                if (error?.status !== 404) {
                    throw error;
                }
                try {
                    await client.issues.createLabel({
                        owner: issue.owner,
                        repo: issue.repo,
                        name: INVALID_LABEL,
                        color: "d73a4a",
                        description: "The issue does not follow the required template.",
                    });
                } catch (createError) {
                    // Another issue event may have created the shared label first.
                    if (createError?.status !== 422) {
                        throw createError;
                    }
                }
            }

            await client.issues.addLabels({
                owner: issue.owner,
                repo: issue.repo,
                issue_number: issue.number,
                labels: [ INVALID_LABEL ],
            });

            const comments = await octokit.paginate(client.issues.listComments, {
                owner: issue.owner,
                repo: issue.repo,
                issue_number: issue.number,
            });

            if (!comments.some(({ body }) => typeof body === "string" && body.includes(COMMENT_MARKER))) {
                await client.issues.createComment({
                    owner: issue.owner,
                    repo: issue.repo,
                    issue_number: issue.number,
                    body: `${COMMENT_MARKER}\n\n@${username}: Hello! :wave:\n\nThis issue is being automatically closed because it does not follow the issue template. Please DO NOT open a blank issue.`,
                });
            }

            // Close the issue
            await client.issues.update({
                owner: issue.owner,
                repo: issue.repo,
                issue_number: issue.number,
                state: "closed",
            });
        } else {
            console.log("Pass!");
        }
    } catch (e) {
        console.error(e);
        process.exitCode = 1;
    }

})();
