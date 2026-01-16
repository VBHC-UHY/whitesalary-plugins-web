// Vercel Serverless Function - 处理插件提交
export default async function handler(req, res) {
    // 只允许 POST 请求
    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, error: 'Method not allowed' });
    }

    // CORS 头
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    try {
        const data = req.body;

        // 验证必填字段
        const required = ['id', 'cn_name', 'author', 'description', 'code'];
        for (const field of required) {
            if (!data[field]) {
                return res.status(400).json({ success: false, error: `缺少必填字段: ${field}` });
            }
        }

        const pluginId = data.id;

        // 验证插件ID格式
        if (!/^[a-z][a-z0-9_]*$/.test(pluginId)) {
            return res.status(400).json({ success: false, error: '插件ID格式不正确' });
        }

        // 从环境变量获取 GitHub 配置
        const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
        const GITHUB_REPO = process.env.GITHUB_REPO || 'VBHC-UHY/whitesalary-plugins';

        if (!GITHUB_TOKEN) {
            return res.status(500).json({ success: false, error: 'GitHub Token 未配置' });
        }

        // 构建 config.json 内容
        const configContent = {
            id: pluginId,
            name: pluginId,
            cn_name: data.cn_name,
            version: data.version || '1.0.0',
            author: data.author,
            description: data.description,
            full_description: data.full_description || data.description,
            category: data.category || '工具',
            keywords: [],
            triggers: data.commands || [],
            features: data.features || [],
            usage: data.usage || '',
            commands: data.commands || [],
            changelog: data.changelog || 'v1.0.0 - 初始版本',
            notes: data.notes || '',
            featured: false
        };

        const headers = {
            'Authorization': `token ${GITHUB_TOKEN}`,
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/json'
        };

        // 上传 plugin.py
        const pluginPath = `plugins/${pluginId}/plugin.py`;
        const pluginUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${pluginPath}`;

        const pluginData = {
            message: `Add plugin: ${data.cn_name}`,
            content: Buffer.from(data.code).toString('base64'),
            branch: 'main'
        };

        let pluginRes = await fetch(pluginUrl, {
            method: 'PUT',
            headers,
            body: JSON.stringify(pluginData)
        });

        if (!pluginRes.ok) {
            const errorText = await pluginRes.text();
            console.error('GitHub API error (plugin.py):', errorText);
            return res.status(500).json({ success: false, error: `上传 plugin.py 失败: ${pluginRes.status}` });
        }

        // 上传 config.json
        const configPath = `plugins/${pluginId}/config.json`;
        const configUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${configPath}`;

        const configData = {
            message: `Add config for: ${data.cn_name}`,
            content: Buffer.from(JSON.stringify(configContent, null, 2)).toString('base64'),
            branch: 'main'
        };

        let configRes = await fetch(configUrl, {
            method: 'PUT',
            headers,
            body: JSON.stringify(configData)
        });

        if (!configRes.ok) {
            const errorText = await configRes.text();
            console.error('GitHub API error (config.json):', errorText);
            return res.status(500).json({ success: false, error: `上传 config.json 失败: ${configRes.status}` });
        }

        // 更新 plugins.json
        const pluginsUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/plugins.json`;

        let pluginsRes = await fetch(pluginsUrl, { headers });
        let pluginsData, sha;

        if (pluginsRes.ok) {
            const pluginsFile = await pluginsRes.json();
            const currentContent = Buffer.from(pluginsFile.content, 'base64').toString('utf-8');
            pluginsData = JSON.parse(currentContent);
            sha = pluginsFile.sha;
        } else {
            pluginsData = { version: '1.0.0', last_updated: '', plugins: [] };
            sha = null;
        }

        // 检查是否已存在
        const existingIds = pluginsData.plugins.map(p => p.id);
        if (existingIds.includes(pluginId)) {
            return res.status(400).json({ success: false, error: '该插件ID已存在' });
        }

        // 添加新插件
        const newPlugin = {
            id: pluginId,
            name: pluginId,
            cn_name: data.cn_name,
            version: data.version || '1.0.0',
            author: data.author,
            description: data.description,
            full_description: data.full_description || data.description,
            category: data.category || '工具',
            keywords: [],
            triggers: data.commands || [],
            features: data.features || [],
            usage: data.usage || '',
            commands: data.commands || [],
            changelog: data.changelog || 'v1.0.0 - 初始版本',
            notes: data.notes || '',
            downloads: 0,
            rating: 5.0,
            featured: false,
            download_url: `https://raw.githubusercontent.com/${GITHUB_REPO}/main/plugins/${pluginId}`
        };

        pluginsData.plugins.push(newPlugin);
        pluginsData.last_updated = new Date().toISOString().split('T')[0];

        // 上传更新后的 plugins.json
        const updateData = {
            message: `Add plugin to list: ${data.cn_name}`,
            content: Buffer.from(JSON.stringify(pluginsData, null, 2)).toString('base64'),
            branch: 'main'
        };
        if (sha) {
            updateData.sha = sha;
        }

        await fetch(pluginsUrl, {
            method: 'PUT',
            headers,
            body: JSON.stringify(updateData)
        });

        return res.status(200).json({
            success: true,
            message: `插件 ${data.cn_name} 提交成功！`
        });

    } catch (error) {
        console.error('Submit error:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
}


