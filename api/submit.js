// Vercel Serverless Function - submit plugins to the remote market repository.
//
// Market schema v2 is intentionally backward compatible:
// - old plugins can omit roles/platforms/assets/dependencies
// - new plugins can declare runtime roles, platform scope, permissions,
//   external services, Python dependencies, and extra resource files

const MARKET_SCHEMA_VERSION = 2;
const DEFAULT_ROLES = ['interceptor', 'rewriter', 'tool_provider'];
const DEFAULT_PLATFORMS = ['all'];
const VALID_ROLES = new Set(['interceptor', 'rewriter', 'tool_provider', 'observer']);
const ROLE_ALIASES = {
  message: 'interceptor',
  reply: 'rewriter',
  tool: 'tool_provider',
  tools: 'tool_provider',
  observe: 'observer',
};

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function asList(value) {
  if (value === undefined || value === null || value === '') return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    return value
      .replace(/，/g, ',')
      .split(/[\n,]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [value];
}

function normalizeStringList(value, options = {}) {
  const {
    defaultValue = [],
    aliases = {},
    allowed = null,
    field = 'field',
  } = options;
  const rawItems = asList(value);
  if (!rawItems.length) return [...defaultValue];

  const result = [];
  const invalid = [];
  for (const raw of rawItems) {
    let item = String(raw).trim().toLowerCase();
    if (!item) continue;
    item = aliases[item] || item;
    if (allowed && !allowed.has(item)) {
      invalid.push(item);
      continue;
    }
    if (!result.includes(item)) result.push(item);
  }

  if (invalid.length) {
    throw new Error(`${field} contains unsupported values: ${invalid.join(', ')}`);
  }
  return result.length ? result : [...defaultValue];
}

function normalizeAssetPaths(value) {
  const result = [];
  for (const raw of asList(value)) {
    const relPath = String(raw).trim().replace(/\\/g, '/').replace(/^\/+/, '');
    if (!relPath) continue;
    const parts = relPath.split('/').filter(Boolean);
    if (!parts.length || parts.includes('..')) {
      throw new Error(`Unsafe asset path: ${raw}`);
    }
    if (['plugin.py', 'config.json', '__init__.py'].includes(relPath)) continue;
    if (!result.includes(relPath)) result.push(relPath);
  }
  return result;
}

function normalizeDependencies(value) {
  if (value === undefined || value === null || value === '') return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  const python = asList(value).map((item) => String(item).trim()).filter(Boolean);
  return python.length ? { python } : {};
}

function normalizeUploadedFiles(files) {
  if (!Array.isArray(files)) return [];
  return files.map((file) => {
    if (!file || !file.path || file.content === undefined) {
      throw new Error('Each uploaded file must include path and content');
    }
    const [safePath] = normalizeAssetPaths([file.path]);
    return {
      path: safePath,
      content: String(file.content),
      encoding: file.encoding || 'utf-8',
    };
  });
}

function buildConfig(data) {
  const pluginId = data.id;
  return {
    schema_version: MARKET_SCHEMA_VERSION,
    id: pluginId,
    name: data.name || pluginId,
    cn_name: data.cn_name,
    version: data.version || '1.0.0',
    author: data.author,
    description: data.description,
    full_description: data.full_description || data.description,
    category: data.category || '工具',
    keywords: asList(data.keywords),
    triggers: asList(data.triggers || data.commands),
    features: asList(data.features),
    usage: data.usage || '',
    commands: asList(data.commands || data.triggers),
    changelog: data.changelog || 'v1.0.0 - 初始版本',
    notes: data.notes || '',
    roles: normalizeStringList(data.roles, {
      defaultValue: DEFAULT_ROLES,
      aliases: ROLE_ALIASES,
      allowed: VALID_ROLES,
      field: 'roles',
    }),
    platforms: normalizeStringList(data.platforms, {
      defaultValue: DEFAULT_PLATFORMS,
      field: 'platforms',
    }),
    permissions: normalizeStringList(data.permissions),
    requires_service: normalizeStringList(data.requires_service || data.requires_services),
    dependencies: normalizeDependencies(data.dependencies),
    assets: normalizeAssetPaths(data.assets),
    featured: false,
  };
}

function buildIndexEntry(config, repo, oldEntry = {}) {
  return {
    schema_version: MARKET_SCHEMA_VERSION,
    id: config.id,
    name: config.name || config.id,
    cn_name: config.cn_name || config.name || config.id,
    version: config.version || '1.0.0',
    author: config.author || '',
    description: config.description || '',
    full_description: config.full_description || config.description || '',
    category: config.category || '工具',
    keywords: config.keywords || [],
    triggers: config.triggers || [],
    features: config.features || [],
    usage: config.usage || '',
    commands: config.commands || config.triggers || [],
    changelog: config.changelog || '',
    notes: config.notes || '',
    roles: config.roles || DEFAULT_ROLES,
    platforms: config.platforms || DEFAULT_PLATFORMS,
    permissions: config.permissions || [],
    requires_service: config.requires_service || [],
    dependencies: config.dependencies || {},
    assets: config.assets || [],
    downloads: Number(oldEntry.downloads || 0),
    rating: Number(oldEntry.rating || 5.0),
    featured: Boolean(oldEntry.featured || false),
    download_url: `https://raw.githubusercontent.com/${repo}/main/plugins/${config.id}`,
  };
}

async function githubFetch(path, headers) {
  const url = `https://api.github.com/${path}`;
  return fetch(url, { headers });
}

async function readGithubJson(repo, path, headers) {
  const response = await githubFetch(`repos/${repo}/contents/${path}`, headers);
  if (!response.ok) return { value: null, sha: null };
  const payload = await response.json();
  const value = JSON.parse(Buffer.from(payload.content, 'base64').toString('utf-8'));
  return { value, sha: payload.sha };
}

async function readGithubSha(repo, path, headers) {
  const response = await githubFetch(`repos/${repo}/contents/${path}`, headers);
  if (!response.ok) return null;
  const payload = await response.json();
  return payload.sha || null;
}

function encodeContent(content, encoding = 'utf-8') {
  if (encoding === 'base64') return String(content);
  return Buffer.from(content).toString('base64');
}

async function putGithubFile(repo, path, content, message, headers, encoding = 'utf-8') {
  const sha = await readGithubSha(repo, path, headers);
  const body = {
    message,
    content: encodeContent(content, encoding),
    branch: 'main',
  };
  if (sha) body.sha = sha;

  const response = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub write failed for ${path}: HTTP ${response.status} ${text}`);
  }
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    const data = req.body || {};
    for (const field of ['id', 'cn_name', 'author', 'description', 'code']) {
      if (!data[field]) {
        return res.status(400).json({ success: false, error: `Missing required field: ${field}` });
      }
    }

    const pluginId = data.id;
    if (!/^[a-z][a-z0-9_]*$/.test(pluginId)) {
      return res.status(400).json({
        success: false,
        error: 'Plugin id must start with a lowercase letter and contain only lowercase letters, numbers, and underscores',
      });
    }

    const token = process.env.GITHUB_TOKEN;
    const repo = process.env.GITHUB_REPO || 'VBHC-UHY/whitesalary-plugins';
    if (!token) {
      return res.status(500).json({ success: false, error: 'GitHub token is not configured' });
    }

    const headers = {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'User-Agent': 'white-salary-plugin-market',
    };

    const config = buildConfig(data);
    const uploadedFiles = normalizeUploadedFiles(data.files);
    for (const file of uploadedFiles) {
      if (!config.assets.includes(file.path)) config.assets.push(file.path);
    }

    const { value: currentIndex, sha: indexSha } = await readGithubJson(repo, 'plugins.json', headers);
    const pluginsData = Array.isArray(currentIndex)
      ? { version: '2.0.0', plugins: currentIndex }
      : (currentIndex || { version: '2.0.0', plugins: [] });

    if (!Array.isArray(pluginsData.plugins)) pluginsData.plugins = [];
    const oldEntry = pluginsData.plugins.find((plugin) => plugin.id === pluginId);
    if (oldEntry && !data.allow_update) {
      return res.status(400).json({
        success: false,
        error: 'This plugin id already exists. Submit with allow_update=true to update it.',
      });
    }

    await putGithubFile(
      repo,
      `plugins/${pluginId}/plugin.py`,
      data.code,
      oldEntry ? `Update plugin: ${data.cn_name}` : `Add plugin: ${data.cn_name}`,
      headers,
    );
    await putGithubFile(
      repo,
      `plugins/${pluginId}/config.json`,
      JSON.stringify(config, null, 2) + '\n',
      oldEntry ? `Update config: ${data.cn_name}` : `Add config: ${data.cn_name}`,
      headers,
    );
    for (const file of uploadedFiles) {
      await putGithubFile(
        repo,
        `plugins/${pluginId}/${file.path}`,
        file.content,
        `Update plugin asset: ${pluginId}/${file.path}`,
        headers,
        file.encoding,
      );
    }

    pluginsData.version = '2.0.0';
    pluginsData.last_updated = new Date().toISOString().slice(0, 10);
    pluginsData.plugins = pluginsData.plugins
      .filter((plugin) => plugin.id !== pluginId)
      .concat(buildIndexEntry(config, repo, oldEntry || {}))
      .sort((a, b) => String(a.cn_name || a.name || a.id).localeCompare(String(b.cn_name || b.name || b.id), 'zh-CN'));
    pluginsData.total_count = pluginsData.plugins.length;

    const updateBody = {
      message: oldEntry ? `Update plugin index: ${data.cn_name}` : `Add plugin to index: ${data.cn_name}`,
      content: Buffer.from(JSON.stringify(pluginsData, null, 2) + '\n').toString('base64'),
      branch: 'main',
    };
    if (indexSha) updateBody.sha = indexSha;

    const updateResponse = await fetch(`https://api.github.com/repos/${repo}/contents/plugins.json`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(updateBody),
    });
    if (!updateResponse.ok) {
      const text = await updateResponse.text();
      throw new Error(`GitHub write failed for plugins.json: HTTP ${updateResponse.status} ${text}`);
    }

    return res.status(200).json({
      success: true,
      message: `Plugin ${data.cn_name} submitted successfully`,
      schema_version: MARKET_SCHEMA_VERSION,
      assets: config.assets,
    });
  } catch (error) {
    console.error('Submit error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
}
