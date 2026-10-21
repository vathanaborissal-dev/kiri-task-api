/**
 * Every command the bot answers, declared once.
 *
 * Three things used to list the commands separately — Telegram's own menu,
 * `/help`, and the check that decides whether an unrecognised `/word` deserves
 * a reply. They drifted: `/alltasks`, `/allissues` and `/hotfixes` shipped
 * without ever reaching the last two. Keeping one list means a new command is
 * documented and recognised the moment it exists.
 */

export type CommandSpec = {
  name: string;
  /** Shown in Telegram's command menu and in `/help`. Keep it short. */
  description: string;
  /** Commands reached by typing rather than browsing stay out of the menu. */
  hidden?: boolean;
};

export type CommandGroup = {
  /** Omitted for the opening group, which needs no heading. */
  heading?: string;
  commands: CommandSpec[];
};

export const COMMAND_GROUPS: CommandGroup[] = [
  {
    heading: 'Your work',
    commands: [
      { name: 'mytasks', description: 'My open tasks' },
      { name: 'today', description: "Today's work and deadlines" },
      { name: 'overdue', description: 'Overdue tasks and issues' },
      { name: 'issues', description: 'Issues assigned to me' },
    ],
  },
  {
    heading: 'The whole team',
    commands: [
      { name: 'alltasks', description: 'Every open task I can see' },
      { name: 'allissues', description: 'Every open issue I can see' },
      { name: 'hotfixes', description: 'Hotfixes in flight' },
      { name: 'projects', description: 'Projects I can access' },
    ],
  },
  {
    heading: 'Everything else',
    commands: [
      { name: 'report', description: 'Report an issue' },
      { name: 'app', description: 'Open Kiri Task' },
      { name: 'me', description: 'My account' },
      { name: 'help', description: 'Show available commands' },
      { name: 'start', description: 'Connect this chat to Kiri Task', hidden: true },
      { name: 'cancel', description: 'Stop what we were in the middle of', hidden: true },
    ],
  },
];

export const ALL_COMMANDS: CommandSpec[] = COMMAND_GROUPS.flatMap((group) => group.commands);

/** `/word` forms the bot knows, so anything else can be answered rather than ignored. */
export const KNOWN_COMMANDS: ReadonlySet<string> = new Set(
  ALL_COMMANDS.map((command) => `/${command.name}`),
);

/** What Telegram shows in the slash menu — the browsable commands, in order. */
export const menuCommands = () =>
  ALL_COMMANDS.filter((command) => !command.hidden).map(({ name, description }) => ({
    command: name,
    description,
  }));
