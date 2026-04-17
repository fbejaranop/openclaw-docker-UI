#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const crypto = require('crypto');

const ROOT = __dirname;
const UI_DIR = path.join(ROOT, 'ui');
const DEFAULT_INSTANCES_DIR = ROOT.includes(`${path.sep}.`)
  ? path.join(process.env.HOME || ROOT, 'openclaw-docker-instances')
  : path.join(ROOT, 'instances');
const INSTANCES_DIR = process.env.UI_INSTANCES_DIR
  ? path.resolve(process.env.UI_INSTANCES_DIR)
  : DEFAULT_INSTANCES_DIR;
const PORT = Number(process.env.UI_PORT || 3080);
const TOOL_PACKAGE_MAP = {
  git: ['git'],
  sdkman: [],
  jq: ['jq'],
  ripgrep: ['ripgrep'],
  fd: ['fd-find'],
  vim: ['vim'],
  tmux: ['tmux'],
  python: ['python3', 'python3-pip', 'python3-venv'],
  buildEssential: ['build-essential'],
  java: ['default-jdk'],
};

fs.mkdirSync(INSTANCES_DIR, { recursive: true });

function currentGroups() {
  try {
    return new Set(os.userInfo().username ? process.getgroups?.() || [] : []);
  } catch {
    return new Set(process.getgroups?.() || []);
  }
}

function dockerCommandArgs(instanceName) {
  const args = ['compose', '-p', `openclaw-${instanceName}`, '-f', 'docker-compose.yml', 'up', '--build', '-d'];
  try {
    const dockerGroup = os.userInfo().username && require('child_process').execFileSync
      ? require('child_process').execFileSync('getent', ['group', 'docker'], { encoding: 'utf8' }).trim()
      : '';
    const groupLine = dockerGroup || '';
    const gid = Number((groupLine.split(':')[2] || '').trim());
    const groups = currentGroups();
    if (Number.isInteger(gid) && gid > 0 && !groups.has(gid)) {
      return {
        file: 'sg',
        args: ['docker', '-c', `docker ${args.map(value => value.replace(/'/g, `'\\''`)).map(value => `'${value}'`).join(' ')}`],
      };
    }
  } catch {
    // fall through to direct docker invocation
  }
  return { file: 'docker', args };
}

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(type === 'application/json' ? JSON.stringify(body, null, 2) : body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 1024 * 1024) {
        reject(new Error('Request too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function slackAppName(value) {
  const parts = String(value || '')
    .trim()
    .match(/[A-Za-z0-9]+/g);
  if (!parts || !parts.length) return 'OpenClaw';
  return parts
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function buildSlackManifest(name) {
  return {
    display_information: {
      name,
      description: 'Slack connector for OpenClaw',
      background_color: '#1f2937',
    },
    features: {
      bot_user: {
        display_name: name,
        always_online: true,
      },
      app_home: {
        home_tab_enabled: true,
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
      slash_commands: [
        {
          command: `/${name}`,
          description: 'Send a message to OpenClaw',
          should_escape: false,
        },
      ],
    },
    oauth_config: {
      scopes: {
        bot: [
          'app_mentions:read',
          'assistant:write',
          'channels:history',
          'channels:read',
          'chat:write',
          'commands',
          'emoji:read',
          'files:read',
          'files:write',
          'groups:history',
          'groups:read',
          'im:history',
          'im:read',
          'im:write',
          'mpim:history',
          'mpim:read',
          'mpim:write',
          'pins:read',
          'pins:write',
          'reactions:read',
          'reactions:write',
          'users:read',
        ],
      },
    },
    settings: {
      socket_mode_enabled: true,
      interactivity: {
        is_enabled: true,
      },
      event_subscriptions: {
        bot_events: [
          'app_mention',
          'channel_rename',
          'member_joined_channel',
          'member_left_channel',
          'message.channels',
          'message.groups',
          'message.im',
          'message.mpim',
          'pin_added',
          'pin_removed',
          'reaction_added',
          'reaction_removed',
        ],
      },
      org_deploy_enabled: false,
      token_rotation_enabled: false,
    },
  };
}

function buildSlackInstructions(name, instanceName) {
  return [
    `1. Go to https://api.slack.com/apps and click Create New App.`,
    `2. Choose From a manifest and select your workspace.`,
    `3. Paste the generated manifest for ${name}.`,
    `4. Create the app, then open Basic Information > App-Level Tokens.`,
    `5. Generate an App Token with the scope connections:write.`,
    `6. Install or reinstall the app to the workspace.`,
    `7. Copy the Bot User OAuth Token (xoxb-...) and the App Token (xapp-...).`,
    `8. Invite the bot to the target channel with /invite @${name}.`,
    `9. In this launcher, paste those tokens and the target Slack channel ID.`,
    `10. Test in Slack with @${name} hello, because channel replies are mention-gated by default.`,
    `11. Instance: ${instanceName}`,
  ].join('\n');
}

function envLine(key, value) {
  const normalized = String(value ?? '').replace(/\r?\n/g, '\\n');
  return `${key}=${normalized}`;
}

function jsonEnvLine(key, value) {
  const json = JSON.stringify(value).replace(/'/g, `'\\''`);
  return `${key}='${json}'`;
}

function composeYaml(instanceName, hostPort, options = {}) {
  const hostSshVolume = options.sshMode === 'host' && options.hostSshPath
    ? `\n      - ${JSON.stringify(options.hostSshPath)}:/ssh-host:ro`
    : '';
  const buildArgs = [
    `        INSTALL_SDKMAN: ${options.installSdkman ? '1' : '0'}`,
    `        EXTRA_APT_PACKAGES: ${JSON.stringify(options.aptPackages || '')}`,
  ].join('\n');
  return `services:
  openclaw:
    build:
      context: ./build-context
      args:
${buildArgs}
    env_file:
      - .env
    ports:
      - "${hostPort}:18789"
    volumes:
      - ./persistent/openclaw-home:/root/.openclaw
      - ./persistent/workspace:/workspace${hostSshVolume}
    restart: unless-stopped
`;
}

function ensurePersistentDirs(instanceDir) {
  const persistentRoot = path.join(instanceDir, 'persistent');
  const openclawHomeDir = path.join(persistentRoot, 'openclaw-home');
  const workspaceDir = path.join(persistentRoot, 'workspace');
  fs.mkdirSync(openclawHomeDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  return { persistentRoot, openclawHomeDir, workspaceDir };
}

function writeBuildContext(instanceDir) {
  const buildContextDir = path.join(instanceDir, 'build-context');
  fs.mkdirSync(buildContextDir, { recursive: true });
  for (const file of ['Dockerfile', 'docker-entrypoint.sh', 'openclaw.template.json']) {
    fs.copyFileSync(path.join(ROOT, file), path.join(buildContextDir, file));
  }
}

function parseExtraAptPackages(value) {
  return String(value || '')
    .split(/[\s,]+/)
    .map(item => item.trim())
    .filter(Boolean);
}

function resolveToolSelection(payload) {
  const selectedTools = Array.isArray(payload.selectedTools)
    ? payload.selectedTools.map(String)
    : [];
  const invalidTools = selectedTools.filter(tool => !(tool in TOOL_PACKAGE_MAP));
  const extraAptPackages = parseExtraAptPackages(payload.extraAptPackages);
  const invalidAptPackages = extraAptPackages.filter(pkg => !/^[a-z0-9][a-z0-9+.-]*$/.test(pkg));

  const aptPackages = Array.from(new Set(
    selectedTools.flatMap(tool => TOOL_PACKAGE_MAP[tool] || []).concat(extraAptPackages)
  ));

  return {
    selectedTools,
    invalidTools,
    extraAptPackages,
    invalidAptPackages,
    aptPackages,
    installSdkman: selectedTools.includes('sdkman'),
  };
}

function validatePayload(payload) {
  const errors = [];
  const instanceName = slugify(payload.instanceName);
  const hostPort = Number(payload.hostPort);
  if (!instanceName) errors.push('instanceName is required');
  if (!Number.isInteger(hostPort) || hostPort < 1 || hostPort > 65535) {
    errors.push('hostPort must be a valid TCP port');
  }
  for (const key of ['openclawModel', 'thinkingDefault', 'gatewayToken']) {
    if (!String(payload[key] || '').trim()) errors.push(`${key} is required`);
  }

  const providerKeys = Array.isArray(payload.providerKeys) ? payload.providerKeys : [];
  if (!providerKeys.length) errors.push('Select at least one model provider');

  const supportedProviders = {
    openai: 'openaiApiKey',
    anthropic: 'anthropicApiKey',
  };
  for (const provider of providerKeys) {
    if (!supportedProviders[provider]) {
      errors.push(`Unsupported provider: ${provider}`);
      continue;
    }
    const keyName = supportedProviders[provider];
    if (!String(payload[keyName] || '').trim()) {
      errors.push(`${keyName} is required when ${provider} is selected`);
    }
  }

  if (payload.slackEnabled) {
    for (const key of ['slackBotToken', 'slackAppToken', 'slackAllowedChannelId']) {
      if (!String(payload[key] || '').trim()) errors.push(`${key} is required when Slack is enabled`);
    }
  }

  const sshMode = String(payload.sshMode || 'generated').trim();
  if (!['generated', 'host'].includes(sshMode)) {
    errors.push('sshMode must be generated or host');
  }
  if (sshMode === 'host' && !String(payload.hostSshPath || '').trim()) {
    errors.push('hostSshPath is required when sshMode=host');
  }

  const toolSelection = resolveToolSelection(payload);
  if (toolSelection.invalidTools.length) {
    errors.push(`Unsupported tools: ${toolSelection.invalidTools.join(', ')}`);
  }
  if (toolSelection.invalidAptPackages.length) {
    errors.push(`Invalid apt package names: ${toolSelection.invalidAptPackages.join(', ')}`);
  }

  return { errors, instanceName, hostPort, sshMode, toolSelection };
}

function writeSlackArtifacts(instanceDir, instanceName) {
  const name = slackAppName(instanceName);
  const manifest = buildSlackManifest(name);
  const instructions = buildSlackInstructions(name, instanceName);
  const manifestPath = path.join(instanceDir, 'slack-manifest.json');
  const instructionsPath = path.join(instanceDir, 'slack-setup.txt');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(instructionsPath, instructions + '\n');
  return {
    name,
    manifest,
    instructions,
    manifestPath,
    instructionsPath,
  };
}

function buildEnv(payload) {
  const providerKeys = Array.isArray(payload.providerKeys) ? payload.providerKeys : [];
  const envConfig = {};
  if (providerKeys.includes('openai') && payload.openaiApiKey) {
    envConfig.OPENAI_API_KEY = payload.openaiApiKey;
  }
  if (providerKeys.includes('anthropic') && payload.anthropicApiKey) {
    envConfig.ANTHROPIC_API_KEY = payload.anthropicApiKey;
  }

  const slackConfig = payload.slackEnabled
    ? {
        enabled: true,
        mode: 'socket',
        botToken: payload.slackBotToken || '',
        appToken: payload.slackAppToken || '',
        groupPolicy: 'allowlist',
        channels: {
          [payload.slackAllowedChannelId || 'C0123456789']: {
            requireMention: true,
          },
        },
        capabilities: {
          interactiveReplies: true,
        },
      }
    : {
        enabled: false,
      };

  return [
    envLine('OPENCLAW_MODEL', payload.openclawModel),
    envLine('OPENCLAW_THINKING_DEFAULT', payload.thinkingDefault),
    envLine('OPENCLAW_GATEWAY_TOKEN', payload.gatewayToken),
    envLine('OPENAI_API_KEY', payload.openaiApiKey || ''),
    envLine('ANTHROPIC_API_KEY', payload.anthropicApiKey || ''),
    envLine('OPENCLAW_SSH_MODE', payload.sshMode || 'generated'),
    envLine('OPENCLAW_HOST_SSH_PATH', payload.hostSshPath || ''),
    jsonEnvLine('ENV_CONFIG_JSON', envConfig),
    jsonEnvLine('SLACK_CONFIG_JSON', slackConfig),
  ].join('\n') + '\n';
}

function ensureStatic(reqPath) {
  const target = reqPath === '/' ? '/index.html' : reqPath;
  const full = path.normalize(path.join(UI_DIR, target));
  if (!full.startsWith(UI_DIR)) return null;
  return full;
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/api/defaults') {
      return send(res, 200, {
        openclawModel: 'openai/gpt-5.4',
        thinkingDefault: 'medium',
        hostPort: 18789,
        gatewayToken: crypto.randomBytes(24).toString('hex'),
        sshMode: 'generated',
        hostSshPath: path.join(process.env.HOME || os.homedir() || '', '.ssh'),
        selectedTools: ['git', 'sdkman'],
        extraAptPackages: '',
      });
    }

    if (req.method === 'POST' && req.url === '/api/containers') {
      const payload = JSON.parse(await readBody(req));
      const { errors, instanceName, hostPort, sshMode, toolSelection } = validatePayload(payload);
      if (errors.length) return send(res, 400, { ok: false, errors });

      const instanceDir = path.join(INSTANCES_DIR, instanceName);
      ensurePersistentDirs(instanceDir);
      writeBuildContext(instanceDir);
      const hostSshPath = sshMode === 'host' ? path.resolve(String(payload.hostSshPath || '').trim()) : '';
      fs.writeFileSync(path.join(instanceDir, '.env'), buildEnv({ ...payload, sshMode, hostSshPath }));
      fs.writeFileSync(path.join(instanceDir, 'docker-compose.yml'), composeYaml(instanceName, hostPort, {
        sshMode,
        hostSshPath,
        installSdkman: toolSelection.installSdkman,
        aptPackages: toolSelection.aptPackages.join(' '),
      }));
      const slackArtifacts = payload.slackEnabled ? writeSlackArtifacts(instanceDir, payload.instanceName || instanceName) : null;

      const dockerCommand = dockerCommandArgs(instanceName);
      execFile(
        dockerCommand.file,
        dockerCommand.args,
        { cwd: instanceDir, timeout: 10 * 60 * 1000 },
        (error, stdout, stderr) => {
          if (error) {
            return send(res, 500, {
              ok: false,
              error: error.message,
              stdout,
              stderr,
              instanceName,
            });
          }
          return send(res, 200, {
            ok: true,
            instanceName,
            hostPort,
            instanceDir,
            command: `${dockerCommand.file} ${dockerCommand.args.join(' ')}`,
            ssh: {
              mode: sshMode,
              hostPath: hostSshPath || null,
            },
            tools: {
              selected: toolSelection.selectedTools,
              aptPackages: toolSelection.aptPackages,
              extraAptPackages: toolSelection.extraAptPackages,
            },
            stdout,
            stderr,
            slack: slackArtifacts,
          });
        }
      );
      return;
    }

    if (req.method === 'GET') {
      const target = ensureStatic(req.url.split('?')[0]);
      if (!target || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
        return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
      }
      const ext = path.extname(target);
      const type = ext === '.html'
        ? 'text/html; charset=utf-8'
        : ext === '.js'
          ? 'text/javascript; charset=utf-8'
          : 'text/plain; charset=utf-8';
      return send(res, 200, fs.readFileSync(target, 'utf8'), type);
    }

    return send(res, 405, 'Method not allowed', 'text/plain; charset=utf-8');
  } catch (error) {
    return send(res, 500, { ok: false, error: error.message });
  }
});

server.listen(PORT, () => {
  console.log(`docker-config UI listening on http://127.0.0.1:${PORT}`);
});
