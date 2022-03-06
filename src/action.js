import core from '@actions/core';
import github from '@actions/github';
import { graphql } from '@octokit/graphql';

const GITHUB_TOKEN = core.getInput('GITHUB_TOKEN');
const { eventName } = github.context;

const graphqlWithAuth = graphql.defaults({
  headers: {
    authorization: `token ${GITHUB_TOKEN}`,
  },
});

async function run() {
  if (eventName !== 'project_card') {
    return;
  }

  // Step 1: Destructure out info from the event (moving a project card) trigging the action.

  const {
    action,
    repository: { node_id: repoNodeId, name: repoName },
    project_card: {
      column_id: newColumnId,
      content_url: contentUrl,
      project_url: projectUrl,
    },
    sender: { name: owner },
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
      issueNumber,
    }
  );

  const contentCreationColumns = projects.edges
    .filter(({ node }) => {
      return node.id === projectId;
    })
    .reduce((acc, cur) => {
      acc[cur.id] = cur.name.toUpperCase();
      return acc;
    }, {});

  const currentTicketStage = contentCreationColumns[newColumnId.toString()];
  const newTicketTitle = `[${currentTicketStage}]: ${title}`;

  // Step 3: Create new issue in target repository with next stage title based on the column name moved to.

  const { issue } = await graphqlWithAuth(
    `
      mutation CreateTicketOnContentCreation(
        $repo: String!
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

  console.log(issue);
}

run();
