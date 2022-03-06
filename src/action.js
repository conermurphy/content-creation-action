import core from '@actions/core';
import github from '@actions/github';
import { graphql } from '@octokit/graphql';

async function run() {
  const GITHUB_TOKEN = core.getInput('GITHUB_TOKEN');
  const PAT_TOKEN = core.getInput('PAT_TOKEN');

  const { eventName } = github.context;

  if (eventName !== 'project_card') {
    return;
  }

  const graphqlWithAuth = graphql.defaults({
    headers: {
      Authorization: `token ${PAT_TOKEN}`,
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

  core.info(projectId);

  const {
    repository: {
      issue: { title },
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
          }
          projects(first: 100) {
            edges {
              node {
                id
                name
                columns(first: 100) {
                  edges {
                    node {
                      name
                      id
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

  core.info(projects);

  const [{ node: contentCreationProject }] = projects.edges.filter(
    ({ node }) => {
      return node.id === projectId;
    }
  );

  const contentCreationColumns = contentCreationProject.columns.edges.reduce(
    (acc, { node }) => {
      acc[node.id] = node.name.toUpperCase();
      return acc;
    },
    {}
  );

  const currentTicketStage = contentCreationColumns[newColumnId.toString()];
  const newTicketTitle = `[${currentTicketStage}]: ${title}`;

  // Step 3: Create new issue in target repository with next stage title based on the column name moved to.

  await graphqlWithAuth(
    `
      mutation CreateTicketOnContentCreation(
        $repo: ID!
        $issueTitle: String!
      ) {
        createIssue(input: { repositoryId: $repo, title: $issueTitle }) {
          issue {
            id
            title
          }
        }
      }
    `,
    {
      repo: repoNodeId,
      issueTitle: newTicketTitle,
    }
  );
}

run();
