import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export type PathOptions = {
  home?: string;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
};

export type OpenClaudePaths = ReturnType<typeof createOpenClaudePaths>;

export function createOpenClaudePaths(options: PathOptions = {}) {
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const openClaudeHome = env.CLAUDE_CONFIG_DIR || join(home, '.openclaude');

  return {
    home,
    openClaudeHome,
    openClaudeConfig: join(home, '.openclaude.json'),
    projectsDir: join(openClaudeHome, 'projects'),
    debugDir: join(openClaudeHome, 'debug'),
    sessionsDir: join(openClaudeHome, 'sessions'),
    statsCache: join(openClaudeHome, 'stats-cache.json'),
    projectSettings(projectPath: string) {
      const base = join(resolve(projectPath), '.openclaude');
      return {
        projectSettings: join(base, 'settings.json'),
        localSettings: join(base, 'settings.local.json'),
      };
    },
  };
}

export function encodeProjectPath(projectPath: string): string {
  return resolve(projectPath).replace(/[^a-zA-Z0-9]/g, '-');
}
