import core from '@actions/core';
import github from '@actions/github';
import { graphql } from '@octokit/graphql';

const LABELS = {
  PLANNING: 'LA_kwDOG8CoYM7oD9GW',
  PRODUCTION: 'LA_kwDOG8CoYM7oeOsf',
  'POST-PRODUCTION': 'LA_kwDOG8CoYM7oeOwb',
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
    sender: { login: owner, node_id: userGlobalNodeId },
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
      issue: { title, labels },
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
            title
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

  if (currentTicketStage === 'PUBLISHED' || currentTicketStage === 'TO DO') {
    return;
  }

  const labelIds = labels.edges
    .filter(({ node }) => {
      return node.id !== 'LA_kwDOG8CoYM7n8qyh';
    })
    .map(({ node }) => {
      return node.id;
    });

  labelIds.push(LABELS[currentTicketStage]);

  // Step 3: Create new issue in target repository with next stage title based on the column name moved to.

  const {
    createIssue: {
      issue: { id: issueId },
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

  // Step 4: Add new issue to the target project

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
}

run();
