// Vercel Serverless Function - 开发者平台API
const crypto = require('crypto');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO = 'VBHC-UHY/whitesalary-plugins';
const API = 'https://api.github.com';

function sha256(str) {
    return crypto.createHash('sha256').update(str).digest('hex');
}

function generateToken() {
    return crypto.randomBytes(32).toString('hex');
}

async function githubGet(path) {
    const resp = await fetch(, {
        headers: { 'Authorization': , 'Accept': 'application/vnd.github.v3+json' }
    });
    if (resp.status !== 200) return null;
    const data = await resp.json();
    const content = Buffer.from(data.content, 'base64').toString('utf-8');
    return { content: JSON.parse(content), sha: data.sha };
}

async function githubPut(path, content, sha, message) {
    const encoded = Buffer.from(JSON.stringify(content, null, 2)).toString('base64');
    const body = { message, content: encoded };
    if (sha) body.sha = sha;
    const resp = await fetch(, {
        method: 'PUT',
        headers: { 'Authorization': , 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return resp.status === 200 || resp.status === 201;
}

async function getDevelopers() {
    const result = await githubGet('developers.json');
    if (!result) return { developers: {}, tokens: {} };
    return result.content;
}

async function saveDevelopers(data, sha) {
    return await githubPut('developers.json', data, sha, 'Update developers');
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const action = req.query.action || req.body?.action;
    
    try {
        const raw = await githubGet('developers.json');
        const devData = raw ? raw.content : { developers: {}, tokens: {} };
        const devSha = raw ? raw.sha : null;

        if (action === 'register') {
            const { username, password } = req.body;
            if (!username || !password) return res.json({ success: false, message: '用户名和密码不能为空' });
            if (username.length < 2 || username.length > 20) return res.json({ success: false, message: '用户名2-20字符' });
            if (password.length < 6) return res.json({ success: false, message: '密码至少6位' });
            if (devData.developers[username]) return res.json({ success: false, message: '用户名已存在' });

            devData.developers[username] = {
                username,
                password_hash: sha256(password),
                role: 'developer',
                status: 'pending',
                created_at: new Date().toISOString().split('T')[0],
                plugins_submitted: [],
            };
            await saveDevelopers(devData, devSha);
            return res.json({ success: true, message: '注册成功，等待管理员审批' });
        }

        if (action === 'login') {
            const { username, password } = req.body;
            const dev = devData.developers[username];
            if (!dev) return res.json({ success: false, message: '用户不存在' });
            if (dev.password_hash !== sha256(password)) return res.json({ success: false, message: '密码错误' });
            if (dev.status !== 'approved') return res.json({ success: false, message: '账号待审批' });

            const token = generateToken();
            if (!devData.tokens) devData.tokens = {};
            devData.tokens[token] = { username, expires_at: Date.now() + 86400000 };
            await saveDevelopers(devData, devSha);
            return res.json({ success: true, token, username, role: dev.role });
        }

        if (action === 'verify') {
            const { token } = req.body;
            const info = devData.tokens?.[token];
            if (!info || Date.now() > info.expires_at) return res.json({ success: false });
            const dev = devData.developers[info.username];
            return res.json({ success: true, username: info.username, role: dev?.role || 'developer' });
        }

        if (action === 'list') {
            const list = Object.values(devData.developers || {}).map(d => ({
                username: d.username, role: d.role, status: d.status,
                created_at: d.created_at, plugins_count: (d.plugins_submitted || []).length,
            }));
            return res.json({ success: true, developers: list });
        }

        return res.json({ success: false, message: '未知操作' });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
}
