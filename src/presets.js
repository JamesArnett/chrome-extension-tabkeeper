// Starting points for grouping rules. `verified` means the selectors were
// confirmed on the live product in October 2026; flip it only after checking live.

export const PRESETS = [
  {
    id: 'jira',
    name: 'Jira issue (Cloud & Data Center)',
    regex: '/browse/([A-Z][A-Z0-9_]+-\\d+)',
    titleTemplate: '$1',
    statusFields: [
      {
        selector:
          '[data-testid="issue.views.issue-base.foundation.status.status-field-wrapper"] button, #status-val',
        keepOnly: '',
        label: '',
      },
    ],
    exampleUrl: 'https://your-site.atlassian.net/browse/ABC-123',
    exampleTitle: 'ABC-123 - In Progress',
    verified: true,
    notes:
      'First alternative is the status button on Jira Cloud, second the status field on Server / Data Center.',
  },
  {
    id: 'github',
    name: 'GitHub pull request / issue',
    regex: 'github\\.com/[^/]+/([^/]+)/(?:pull|issues)/(\\d+)',
    titleTemplate: '$1#$2',
    statusFields: [
      {
        selector: '[data-testid="header-state"], [data-component="StateLabel"], .gh-header-meta .State, .gh-header-sticky .State',
        keepOnly: '',
        label: '',
      },
    ],
    exampleUrl: 'https://github.com/octocat/hello-world/pull/42',
    exampleTitle: 'hello-world#42 - Open',
    verified: true,
    notes:
      'Confirmed on github.com in October 2026: pull requests carry data-testid="header-state"; issue pages only carry data-component="StateLabel", listed second. Reads Open, Draft, Merged or Closed. GitHub Enterprise users: replace the hostname in the regex.',
  },
  {
    id: 'gitlab-mr',
    name: 'GitLab merge request (+ pipeline)',
    regex: '/([^/]+)/-/merge_requests/(\\d+)',
    titleTemplate: '$1!$2',
    statusFields: [
      {
        selector:
          '.merge-request-sticky-header .detail-page-description .gl-badge .gl-badge-content, .merge-request-details .detail-page-description .gl-badge .gl-badge-content, .issuable-status-badge .gl-badge-content, [data-testid="issuable-status-badge"] .gl-badge-content',
        keepOnly: '',
        label: '',
      },
      { selector: '.mr-pipeline-title', keepOnly: '#\\d+\\s+(\\S+)', label: 'CI' },
    ],
    exampleUrl: 'https://gitlab.example.com/group/project/-/merge_requests/17',
    exampleTitle: 'project!17 - Open · CI passed',
    verified: true,
    notes:
      'Confirmed on GitLab 19.3 self-managed. The state badge is in the sticky header under .detail-page-description, not .detail-page-header (that row holds the "Try Rapid Diffs · Beta" badge). Field 2 reads "Pipeline #18395789 passed" and keeps the last word; MRs without a pipeline show field 1 only.',
  },
  {
    id: 'gitlab-issue',
    name: 'GitLab issue',
    regex: '/([^/]+)/-/issues/(\\d+)',
    titleTemplate: '$1#$2',
    statusFields: [
      {
        selector:
          '.issuable-details .detail-page-description .gl-badge .gl-badge-content, .issuable-status-badge .gl-badge-content, [data-testid="issue-state-badge"] .gl-badge-content, [data-testid="work-item-state-badge"], .issuable-status-badge',
        keepOnly: '',
        label: '',
      },
    ],
    exampleUrl: 'https://gitlab.example.com/group/project/-/issues/5',
    exampleTitle: 'project#5 - Open',
    verified: false,
    notes: 'Derived from GitLab markup; Test it on your instance first.',
  },
  {
    id: 'gitlab-pipeline',
    name: 'GitLab pipeline',
    regex: '/([^/]+)/-/pipelines/(\\d+)',
    titleTemplate: '$1 pipeline #$2',
    statusFields: [
      {
        selector: '[data-testid="pipeline-details-header"] [data-testid="ci-icon-text"], [data-testid="ci-icon-text"]',
        keepOnly: '',
        label: '',
      },
    ],
    exampleUrl: 'https://gitlab.example.com/group/project/-/pipelines/18395616',
    exampleTitle: 'project pipeline #18395616 - Blocked',
    verified: true,
    notes: 'Job badges lower on the page reuse data-testid="ci-icon-text", so the header-scoped alternative is listed first.',
  },
  {
    id: 'azure-devops',
    name: 'Azure DevOps work item',
    regex: 'dev\\.azure\\.com/[^/]+/([^/]+)/_workitems/edit/(\\d+)',
    titleTemplate: '$1 #$2',
    statusFields: [
      { selector: 'input[aria-label="State Field"], [aria-label="State Field"] input', keepOnly: '', label: '' },
    ],
    exampleUrl: 'https://dev.azure.com/org/Project/_workitems/edit/1234',
    exampleTitle: 'Project #1234 - Active',
    verified: false,
    notes: 'The State field is an <input>, so its value is read. *.visualstudio.com hosts need the regex edited.',
  },
  {
    id: 'servicenow',
    name: 'ServiceNow incident',
    regex: '\\b(INC\\d{7,})\\b',
    titleTemplate: '$1',
    statusFields: [
      { selector: 'select[id$=".state"] option:checked, [aria-label="State"] input', keepOnly: '', label: '' },
    ],
    exampleUrl: 'https://instance.service-now.com/nav_to.do?uri=incident.do?sys_id=…',
    exampleTitle: 'INC0010042 - In Progress',
    verified: false,
    notes:
      'The incident number is not in the URL, so the regex matches the tab title. Classic UI renders the form in an iframe. Workspace (Next Experience) layouts may need a different selector.',
  },
];

export const DEFAULT_STATUS_SELECTOR = PRESETS[0].statusFields[0].selector;

export function getPreset(id) {
  return PRESETS.find((p) => p.id === id) ?? null;
}
