export const effortLevels = {
  codex: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
} as const;

export type Effort = (typeof effortLevels)[keyof typeof effortLevels][number];
export const defaultEffort: Effort = 'high';
