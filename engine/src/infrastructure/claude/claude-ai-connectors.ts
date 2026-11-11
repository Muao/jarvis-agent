import type { ClaudeAiConnector } from '@jarvis/shared';

interface ConnectorTools {
  /** The server part of a tool name: `mcp__<server>__<tool>`. */
  readonly server: string;
  /** What `claude mcp list` calls it. */
  readonly name: string;
  readonly url: string;
  /** Tools that only read. A run may call these without asking. */
  readonly read: readonly string[];
  /** Every other tool the connector had on 2026-11-11. A run is denied these outright. */
  readonly other: readonly string[];
}

/**
 * ADR-0027: the claude.ai connectors a run may be given, each split into the tools that read
 * what a task needs and the rest. A connector is the owner's whole account in that service, so nothing here is allowed by
 * pattern: a tool is readable because it is named in `read`, and a tool the connector grows later
 * is in neither list — the run has to ask the owner for it (`mcp__jarvis__approve`).
 */
export const CLAUDE_AI_CONNECTORS: Readonly<Record<ClaudeAiConnector, ConnectorTools>> = {
  notion: {
    server: 'claude_ai_Notion',
    name: 'claude.ai Notion',
    url: 'https://mcp.notion.com/mcp',
    read: [
      'notion-fetch',
      'notion-search',
      'notion-get-comments',
      'notion-get-self',
      'notion-get-teams',
      'notion-get-users',
      'notion-get-suggested-edit',
      'notion-get-version-changes',
      'notion-view-version',
      'notion-list-favorite-pages',
      'notion-list-page-backlinks',
      'notion-list-private-pages',
      'notion-list-recent-pages',
      'notion-list-shared-pages',
      'notion-query-data-sources',
      'notion-query-multiple-data-sources',
      'notion-query-meeting-notes',
    ],
    other: [
      'notion-calendar-cancel-events',
      'notion-calendar-create-events',
      'notion-calendar-list-calendar-resources',
      'notion-calendar-list-calendars',
      'notion-calendar-list-contacts',
      'notion-calendar-list-coworkers-events',
      'notion-calendar-list-events',
      'notion-calendar-update-events',
      'notion-complete-mcp-setup',
      'notion-convert-page-to-skill',
      'notion-convert-to-meetings-database',
      'notion-create-attachment',
      'notion-create-comment',
      'notion-create-database',
      'notion-create-file-upload',
      'notion-create-folder',
      'notion-create-meeting-note',
      'notion-create-pages',
      'notion-create-suggested-edit',
      'notion-create-view',
      'notion-delete-comment',
      'notion-delete-databases',
      'notion-delete-pages',
      'notion-download-attachment',
      'notion-download-skill',
      'notion-duplicate-page',
      'notion-get-async-task',
      'notion-get-enabled-skills',
      'notion-get-file-download-urls',
      'notion-get-groups',
      'notion-get-session-status',
      'notion-get-setup-guide',
      'notion-get-sidebar-tabs',
      'notion-get-tool-access',
      'notion-link-meeting-note-to-calendar-event',
      'notion-list-session-events',
      'notion-memory-search',
      'notion-move-pages',
      'notion-query-sessions',
      'notion-read-session-event',
      'notion-resolve-suggested-edit',
      'notion-restore-pages',
      'notion-restore-version',
      'notion-search-agents',
      'notion-search-sessions',
      'notion-send-message-to-session',
      'notion-set-comment-reaction',
      'notion-set-discussion-resolved',
      'notion-spawn-session',
      'notion-stop-session',
      'notion-update-comment',
      'notion-update-data-source',
      'notion-update-folder',
      'notion-update-page',
      'notion-update-page-favorites',
      'notion-update-sidebar-tabs',
      'notion-update-skill-settings',
      'notion-update-view',
      'notion-upload-skill',
      'notion-wait-session',
    ],
  },
  slack: {
    server: 'claude_ai_Slack',
    name: 'claude.ai Slack',
    url: 'https://mcp.slack.com/mcp',
    read: [
      'slack_read_channel',
      'slack_read_thread',
      'slack_read_canvas',
      'slack_read_file',
      'slack_read_list',
      'slack_read_user_profile',
      'slack_search_channels',
      'slack_search_public',
      'slack_search_public_and_private',
      'slack_search_users',
      'slack_list_channel_members',
      'slack_list_user_channels',
      'slack_get_reactions',
    ],
    other: [
      'slack_add_list_record',
      'slack_add_reaction',
      'slack_complete_file_upload',
      'slack_create_canvas',
      'slack_create_conversation',
      'slack_create_list',
      'slack_get_file_upload_url',
      'slack_schedule_message',
      'slack_search_emojis',
      'slack_send_message',
      'slack_send_message_draft',
      'slack_update_canvas',
      'slack_update_list',
      'slack_update_list_record',
    ],
  },
  google_docs: {
    server: 'claude_ai_Google_Docs',
    name: 'claude.ai Google Docs',
    url: 'https://docsmcp.googleapis.com/mcp/v1',
    read: ['read_doc'],
    other: ['update_doc'],
  },
  google_drive: {
    server: 'claude_ai_Google_Drive',
    name: 'claude.ai Google Drive',
    url: 'https://drivemcp.googleapis.com/mcp/v1',
    read: [
      'download_file_content',
      'get_file_metadata',
      'get_file_permissions',
      'get_shared_drive_metadata',
      'list_recent_files',
      'list_shared_drives',
      'read_file_content',
      'search_files',
    ],
    other: ['copy_file', 'create_file', 'share_file', 'trash_file', 'update_file'],
  },
};

/**
 * The other connectors the owner's account had on 2026-11-11. Leaving strict mode brings in every
 * connector of the account, so the ones no run is given are denied by server.
 */
const OTHER_ACCOUNT_SERVERS = [
  'claude_ai_Claude_Docs',
  'claude_ai_Gamma',
  'claude_ai_Gmail',
  'claude_ai_Google_Calendar',
  'claude_ai_Google_Sheets',
  'claude_ai_Google_Slides',
] as const;

const ALL = Object.keys(CLAUDE_AI_CONNECTORS) as ClaudeAiConnector[];

/**
 * True when the run is started without `--strict-mcp-config`. A `ui_check` run never is: it
 * stands in someone else's pull request (ADR-0018) and has no business in the owner's accounts.
 */
export function usesClaudeAiConnectors(
  selected: readonly ClaudeAiConnector[] | undefined,
  taskKind: string | undefined,
): selected is readonly ClaudeAiConnector[] {
  return selected !== undefined && selected.length > 0 && taskKind !== 'ui_check';
}

/** Permission rules for the read tools of the selected connectors. */
export function claudeAiAllowRules(selected: readonly ClaudeAiConnector[]): string[] {
  return ALL.filter((id) => selected.includes(id)).flatMap((id) => {
    const { server, read } = CLAUDE_AI_CONNECTORS[id];
    return read.map((tool) => `mcp__${server}__${tool}`);
  });
}

/**
 * Permission rules that take everything else out of the run: the non-reading tools of a selected
 * connector one by one, every other known connector as a whole server. Empty when nothing is
 * selected — a strict run has no account connector to deny.
 */
export function claudeAiDenyRules(selected: readonly ClaudeAiConnector[]): string[] {
  if (selected.length === 0) return [];
  return [
    ...ALL.flatMap((id) => {
      const { server, other } = CLAUDE_AI_CONNECTORS[id];
      return selected.includes(id)
        ? other.map((tool) => `mcp__${server}__${tool}`)
        : [`mcp__${server}`];
    }),
    ...OTHER_ACCOUNT_SERVERS.map((server) => `mcp__${server}`),
  ];
}
