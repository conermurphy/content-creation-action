import core from '@actions/core';
import github from '@actions/github';
import { graphql } from '@octokit/graphql';

const LABELS = {
  PLANNING: 'LA_kwDOG8CoYM7oD9GW',
  PRODUCTION: 'LA_kwDOG8CoYM7oeOsf',
  'POST-PRODUCTION': 'LA_kwDOG8CoYM7oeOwb',
};

const ISSUE_BODIES = {
  PLANNING: `
## Keyword Research
> *What keywords will this piece of content target?*

## Coverage / Inspiration
> *How well covered is this topic on the chosen publishing platform? What is special about existing high performing content? How can it inspire my piece of content?*

## Concept
> *What is the main concept of this piece of content? How should the content flow? What will the consumer take away from this content? What’s the value in it?*

## Outline
> *Outline the content below*

### Intro

### Upfront Conclusion

### Main Body

### Conclusion/Outro
  `,
  'POST-PRODUCTION': `
## Titles
> *10 possible titles, 🌟 favourites*

## Thumbnail / Featured Images
> *3 Version of thumbnails / featured images*
  `,
};

async function run() {
  const GITHUB_TOKEN = core.getInput('PAT_TOKEN');
  const PROJECT_TO_ADD_TO = core.getInput('PROJECT_TO_ADD_TO');

  const { eventName } = github.context;

  if (eventName !== 'project_card') {
    return;
  }

  const graphqlWithAuth = graphql.defaults({
    headers: {
      Authorization: `token ${GITHUB_TOKEN}`,
    },
  });

  // Step 1: Destructure out info from the event (moving a project card) trigging the action.

  const {
    action,
    repository: { node_id: repoNodeId, name: repoName },
    project_card: {
      column_id: newColumnId,
      content_url: contentUrl,
      project_url: projectUrl,
    },
    sender: { login: owner },
  } = github.context.payload;

  if (action !== 'moved') {
    return;
  }

  // Step 2: Get info on issue moved in project and create title for issue to be created in step 2.

  // Split on last / in URL and destructure value following as it will be issue number. E.g. https://api.github.com/repos/api-playground/projects-test/issues/3 will become 3.

  const [, issueNumber] = contentUrl.split(/\/(?=[^/]+$)/);
  const [, projectId] = projectUrl.split(/\/(?=[^/]+$)/);

  const {
    repository: {
      issue: {
        title,
        id: originalIssueId,
        body: originalIssueBody,
        number: originalIssueNumber,
        labels: { edges: originalLabels },
      },
      projects,
    },
  } = await graphqlWithAuth(
    `
      query FindIssuesInRepo(
        $owner: String!
        $repoName: String!
        $issueNumber: Int!
      ) {
        repository(owner: $owner, name: $repoName) {
          issue(number: $issueNumber) {
            id
            number
            title
            body
            labels(first:100) {
              edges {
                node {
                  id
                }
              }
            }
          }
          projects(first: 100) {
            edges {
              node {
                id
                databaseId
                name
                columns(first: 100) {
                  edges {
                    node {
                      name
                      id
                      databaseId
                    }
                  }
                }
              }
            }
          }
        }
      }
    `,
    {
      owner,
      repoName,
      issueNumber: parseInt(issueNumber),
    }
  );

  const [{ node: contentCreationProject }] = projects.edges.filter(
    ({ node }) => {
      return node.databaseId === parseInt(projectId);
    }
  );

  const contentCreationColumns = contentCreationProject.columns.edges.reduce(
    (acc, { node }) => {
      acc[node.databaseId] = node.name.toUpperCase();
      return acc;
    },
    {}
  );

  const currentTicketStage = contentCreationColumns[newColumnId];
  const newTicketTitle = `[${currentTicketStage}]: ${title}`;

  if (
    !['PLANNING', 'PRODUCTION', 'POST-PRODUCTION'].includes(currentTicketStage)
  ) {
    return;
  }

  // Step 3: Create new issue in target repository with next stage title based on the column name moved to.

  const {
    createIssue: {
      issue: { id: issueId, number: newIssueNumber },
    },
  } = await graphqlWithAuth(
    `
      mutation CreateIssue(
        $repo: ID!
        $issueTitle: String!
        $template: String
      ) {
        createIssue(
          input: {
            repositoryId: $repo
            title: $issueTitle
            issueTemplate: $template
          }
        ) {
          issue {
            id
            labels(first: 100) {
              edges {
                node {
                  id
                }
              }
            }
            number
            body
          }
        }
      }
    `,
    {
      repo: repoNodeId,
      issueTitle: newTicketTitle,
      template: currentTicketStage,
    }
  );

  // Step 4: Update issue to add in labels and body for individual stage in the process and reference to parent ticket.

  const updatedLabels = originalLabels
    .filter(({ node }) => {
      return node.id !== 'LA_kwDOG8CoYM7n8qyh';
    })
    .map(({ node }) => {
      return node.id;
    });

  updatedLabels.push(LABELS[currentTicketStage]);

  const newIssueUpdatedBody = `
- Parent Ticket: #${originalIssueNumber}
---
${ISSUE_BODIES[currentTicketStage]}`;

  await graphqlWithAuth(
    `
      mutation UpdateIssueWithLabel($issueId: ID!, $labels: [ID!], $body: String) {
        updateIssue(input: { id: $issueId, labelIds: $labels, body: $body }) {
          issue {
            id
          }
        }
      }
    `,
    {
      issueId,
      labels: updatedLabels,
      body: newIssueUpdatedBody,
    }
  );

  // Step 5: Add new issue to the provided project

  await graphqlWithAuth(
    `
      mutation AddItem($projectId: ID!, $issueId: ID!) {
        addProjectNextItem(
          input: { projectId: $projectId, contentId: $issueId }
        ) {
          projectNextItem {
            id
          }
        }
      }
    `,
    { issueId, projectId: PROJECT_TO_ADD_TO }
  );

  // Step 6: Update body of the original parent issue to add a link to new sub issue

  const updatedBody = `
  ${originalIssueBody}
---
## Linked Issues
- ${currentTicketStage}: #${newIssueNumber}`;

  await graphqlWithAuth(
    `
      mutation UpdateOriginalIssue($issueId: ID!, $body: String) {
        updateIssue(input: { id: $issueId, body: $body }) {
          issue {
            id
          }
        }
      }
    `,
    {
      issueId: originalIssueId,
      body: updatedBody,
    }
  );
}

run();
