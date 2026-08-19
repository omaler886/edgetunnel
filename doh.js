/**
 * API Gateway — Cloudflare Workers v2026-08-19-fix2
 */

// ==================== 上游配置 ====================

const UPSTREAM_CONFIGS = [
	{
		name: 'cloudflare',
		label: 'Cloudflare 1.1.1.1',
		dohUrl: 'https://cloudflare-dns.com/dns-query',
		jsonUrl: 'https://cloudflare-dns.com/dns-query',
		ecsSupported: true,
	},
	{
		name: 'google',
		label: 'Google 8.8.8.8',
		dohUrl: 'https://dns.google/dns-query',
		jsonUrl: 'https://dns.google/resolve',
		ecsSupported: true,
	},
	{
		name: 'opendns',
		label: 'OpenDNS',
		dohUrl: 'https://doh.opendns.com/dns-query',
		jsonUrl: null,
		ecsSupported: true,
	},
	{
		name: 'quad9',
		label: 'Quad9 9.9.9.9',
		dohUrl: 'https://dns.quad9.net/dns-query',
		jsonUrl: null,
		ecsSupported: true,
	},
];

// ==================== 全局状态 ====================

let upstreamRRIndex = 0;
const stats = {
	startTime: Date.now(),
	totalQueries: 0,
	cacheHits: 0,
	cacheMisses: 0,
	ecsInjected: 0,
	echServed: 0,
	upstreamStats: {},
};
for (const u of UPSTREAM_CONFIGS) {
	stats.upstreamStats[u.name] = { queries: 0, errors: 0, totalLatency: 0 };
}

const upstreamHealth = {};
for (const u of UPSTREAM_CONFIGS) {
	upstreamHealth[u.name] = { healthy: true, lastError: 0, consecutiveFailures: 0 };
}

// 速率统计：记录最近请求的 (ts, upstream, cacheHit)，用于计算 QPS / 速率
const rateLog = { ts: [], upstream: [], cache: [] };
function recordRate(upstreamName, cacheHit) {
	const now = Date.now();
	rateLog.ts.push(now);
	rateLog.upstream.push(upstreamName || '');
	rateLog.cache.push(cacheHit ? 1 : 0);
	// 只保留最近 5 分钟
	const cutoff = now - 300000;
	while (rateLog.ts.length > 0 && rateLog.ts[0] < cutoff) {
		rateLog.ts.shift();
		rateLog.upstream.shift();
		rateLog.cache.shift();
	}
}
function computeRates() {
	const now = Date.now();
	const win1 = now - 60000, win5 = now - 300000;
	const r1 = { total: 0, byUpstream: {}, cacheHit: 0, cacheMiss: 0 };
	const r5 = { total: 0, byUpstream: {}, cacheHit: 0, cacheMiss: 0 };
	for (let i = 0; i < rateLog.ts.length; i++) {
		const ts = rateLog.ts[i];
		if (ts >= win1) {
			r1.total++;
			r1.byUpstream[rateLog.upstream[i]] = (r1.byUpstream[rateLog.upstream[i]] || 0) + 1;
			if (rateLog.cache[i]) r1.cacheHit++; else r1.cacheMiss++;
		}
		if (ts >= win5) {
			r5.total++;
			r5.byUpstream[rateLog.upstream[i]] = (r5.byUpstream[rateLog.upstream[i]] || 0) + 1;
			if (rateLog.cache[i]) r5.cacheHit++; else r5.cacheMiss++;
		}
	}
	const qps1 = r1.total / 60, qps5 = r5.total / 300;
	const hitRate1 = r1.total ? (r1.cacheHit / r1.total * 100) : 0;
	const hitRate5 = r5.total ? (r5.cacheHit / r5.total * 100) : 0;
	return { qps1, qps5, total1: r1.total, total5: r5.total, hitRate1, hitRate5, byUpstream1: r1.byUpstream, byUpstream5: r5.byUpstream };
}

// Analytics Engine：全局 QPS（跨边缘节点）
function writeAnalytics(env, ctx, op) {
	if (!env || !env.ANALYTICS) return;
	ctx && ctx.waitUntil && ctx.waitUntil((async () => {
		try {
			env.ANALYTICS.writeDataPoint({
				indexes: [op.colo || 'UNKNOWN', op.upstream || 'none'],
				blobs: [op.domain || '', String(op.cache ? 'hit' : 'miss')],
				doubles: [1],
			});
		} catch {}
	})());
}
// 查询全局 QPS（Analytics Engine，SQLite 语法，BlazeDB 方言）
async function queryGlobalQPS(env) {
	if (!env || !env.ANALYTICS) return null;
	try {
		const now = Math.floor(Date.now() / 1000);
		// Analytics Engine SQL: SELECT ... FROM <dataset> WHERE timestamp >= ...
		const rows = await env.ANALYTICS.query(`SELECT count() AS total FROM doh_qps WHERE timestamp >= toDateTime(${now - 60})`);
		const t60 = (rows && rows.length) ? rows[0].total : 0;
		const rows5 = await env.ANALYTICS.query(`SELECT count() AS total FROM doh_qps WHERE timestamp >= toDateTime(${now - 300})`);
		const t300 = (rows5 && rows5.length) ? rows5[0].total : 0;
		// 按上游分组 60s
		const rowsUp = await env.ANALYTICS.query(`SELECT index1 AS up, count() AS c FROM doh_qps WHERE timestamp >= toDateTime(${now - 60}) GROUP BY index1`);
		const byUp = {};
		if (rowsUp && rowsUp.length) for (const r of rowsUp) byUp[r.up] = r.c;
		// 按缓存分组 60s
		const rowsCache = await env.ANALYTICS.query(`SELECT blob1 AS hit, count() AS c FROM doh_qps WHERE timestamp >= toDateTime(${now - 60}) GROUP BY blob1`);
		let cacheHit = 0, cacheTotal = 0;
		// 兼容不同返回格式
		if (rowsCache && rowsCache.length) {
			// rowsCache 可能是 map 或数组
			if (Array.isArray(rowsCache)) {
				for (const r of rowsCache) {
					const key = r.hit === undefined ? (r[0] === undefined ? Object.values(r)[0] : r[0]) : r.hit;
					const val = r.c !== undefined ? r.c : r[Object.keys(r).find(k=>k!=='hit')];
					if (String(key) === 'hit') cacheHit = val;
					cacheTotal += val;
				}
			} else if (typeof rowsCache === 'object') {
				cacheHit = rowsCache.hit || 0;
				cacheTotal = rowsCache.hit + (rowsCache.miss || 0);
			}
		}
		return {
			qps60: +(t60 / 60).toFixed(2),
			total60: t60,
			total300: t300,
			byUpstream: byUp,
			cacheHit,
			cacheTotal,
			cacheHitRate: cacheTotal ? (cacheHit / cacheTotal * 100).toFixed(1) + '%' : '0%',
		};
	} catch (e) {
		return null;
	}
}

const recentQueries = [];
const DNS_TYPE_NAMES = { 1: 'A', 2: 'NS', 5: 'CNAME', 6: 'SOA', 12: 'PTR', 15: 'MX', 16: 'TXT', 28: 'AAAA', 33: 'SRV', 43: 'DS', 46: 'RRSIG', 47: 'NSEC', 48: 'DNSKEY', 64: 'SVCB', 65: 'HTTPS', 255: 'ANY' };
function addRecent(name, qtype, env, ctx, request) {
	if (!name) return;
	const limit = Math.min(Math.max(parseInt(env && env.RECENT_LIMIT) || 2000, 100), 10000);
	const t = DNS_TYPE_NAMES[qtype] || qtype;
	const colo = (request && request.cf && request.cf.colo) ? request.cf.colo : 'UNKNOWN';
	const entry = { c: colo, n: name, t, ts: Date.now() };
	// 内存保留对象
	recentQueries.push(entry);
	if (recentQueries.length > limit) recentQueries.splice(0, recentQueries.length - limit);
	// 同步到 KV 实现全局共享
	if (env && env.RECENT_KV && ctx) {
		ctx.waitUntil((async () => {
			try {
				const raw = await env.RECENT_KV.get('recent');
				let list = raw ? JSON.parse(raw) : [];
				// 兼容旧字符串格式
				list.push(entry);
				if (list.length > limit) list = list.slice(-limit);
				await env.RECENT_KV.put('recent', JSON.stringify(list));
			} catch {}
		})());
	}
}

// ==================== DNS 二进制工具 ====================

function readU16(buf, off) {
	return (buf[off] << 8) | buf[off + 1];
}

function writeU16(buf, val, off) {
	buf[off] = (val >> 8) & 0xff;
	buf[off + 1] = val & 0xff;
}

function writeU32(buf, val, off) {
	buf[off] = (val >> 24) & 0xff;
	buf[off + 1] = (val >> 16) & 0xff;
	buf[off + 2] = (val >> 8) & 0xff;
	buf[off + 3] = val & 0xff;
}

function concatBytes(...arrays) {
	const total = arrays.reduce((s, a) => s + a.length, 0);
	const result = new Uint8Array(total);
	let off = 0;
	for (const a of arrays) {
		result.set(a, off);
		off += a.length;
	}
	return result;
}

function skipName(buf, off) {
	while (off < buf.length) {
		const len = buf[off];
		if (len === 0) return off + 1;
		if ((len & 0xc0) === 0xc0) return off + 2;
		off += len + 1;
	}
	return off;
}

function skipRR(buf, off) {
	off = skipName(buf, off);
	off += 2; // type
	off += 2; // class
	off += 4; // ttl
	const rdlength = readU16(buf, off);
	off += 2; // rdlength
	off += rdlength; // rdata
	return off;
}

function parseQuestion(buf) {
	const qdcount = readU16(buf, 4);
	let off = 12;
	const questions = [];
	for (let i = 0; i < qdcount && off < buf.length; i++) {
		const parts = [];
		let nameOff = off;
		while (nameOff < buf.length) {
			const len = buf[nameOff];
			if (len === 0) break;
			if ((len & 0xc0) === 0xc0) break;
			nameOff++;
			parts.push(new TextDecoder().decode(buf.slice(nameOff, nameOff + len)));
			nameOff += len;
		}
		off = skipName(buf, off);
		const qtype = readU16(buf, off);
		off += 2;
		const qclass = readU16(buf, off);
		off += 2;
		questions.push({ name: parts.join('.'), qtype, qclass });
	}
	return { questions, questionEnd: off };
}

// ==================== Base64 / 编码工具 ====================

function base64UrlToBytes(b64) {
	const s = b64.replace(/-/g, '+').replace(/_/g, '/');
	const padded = s + '==='.slice((s.length + 3) % 4);
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

async function sha256Hex(text) {
	const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// ==================== ECS (EDNS Client Subnet) 注入 ====================

function parseClientIP(ipStr) {
	if (!ipStr) return null;

	if (ipStr.includes(':')) {
		const parts = ipStr.split(':');
		const expanded = [];
		for (let i = 0; i < parts.length; i++) {
			if (parts[i] === '' && i === 0) { expanded.push('0000'); continue; }
			if (parts[i] === '') {
				const fill = 8 - parts.length + 1;
				for (let j = 0; j < fill; j++) expanded.push('0000');
			} else {
				expanded.push(parts[i].padStart(4, '0'));
			}
		}
		while (expanded.length < 8) expanded.push('0000');
		const bytes = new Uint8Array(16);
		for (let i = 0; i < 8 && i < expanded.length; i++) {
			bytes[i * 2] = parseInt(expanded[i].slice(0, 2), 16);
			bytes[i * 2 + 1] = parseInt(expanded[i].slice(2, 4), 16);
		}
		return { family: 2, prefix: 56, bytes };
	}

	if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ipStr)) {
		const parts = ipStr.split('.').map(Number);
		const bytes = new Uint8Array(4);
		for (let i = 0; i < 4; i++) bytes[i] = parts[i];
		return { family: 1, prefix: 24, bytes };
	}

	return null;
}

function buildECSOption(clientInfo, prefixLen) {
	const prefix = prefixLen || clientInfo.prefix;
	const addrBytes = Math.ceil(prefix / 8);
	const address = clientInfo.bytes.slice(0, addrBytes);

	const optLen = 2 + 1 + 1 + address.length;
	const option = new Uint8Array(4 + optLen);
	writeU16(option, 8, 0);
	writeU16(option, optLen, 2);
	writeU16(option, clientInfo.family, 4);
	option[6] = prefix;
	option[7] = 0;
	option.set(address, 8);
	return option;
}

function injectECS(query, clientIP, ipv4Prefix, ipv6Prefix) {
	const clientInfo = parseClientIP(clientIP);
	if (!clientInfo) return query;

	const prefix = clientInfo.family === 1 ? (ipv4Prefix || 24) : (ipv6Prefix || 56);
	clientInfo.prefix = prefix;
	const ecsOption = buildECSOption(clientInfo, prefix);

	const buf = query instanceof Uint8Array ? query : new Uint8Array(query);

	const qdcount = readU16(buf, 4);
	const ancount = readU16(buf, 6);
	const nscount = readU16(buf, 8);
	const arcount = readU16(buf, 10);

	let off = 12;
	for (let i = 0; i < qdcount; i++) {
		off = skipName(buf, off);
		off += 4;
	}

	for (let i = 0; i < ancount + nscount; i++) {
		off = skipRR(buf, off);
	}

	let optRdataStart = -1;
	let optRdataEnd = -1;
	let optRdlengthOffset = -1;

	let scanOff = off;
	for (let i = 0; i < arcount && scanOff < buf.length; i++) {
		scanOff = skipName(buf, scanOff);
		const rtype = readU16(buf, scanOff);
		scanOff += 2;
		scanOff += 2;
		scanOff += 4;
		optRdlengthOffset = scanOff;
		const rdlength = readU16(buf, scanOff);
		scanOff += 2;
		const rdataStart = scanOff;
		scanOff += rdlength;

		if (rtype === 41) {
			optRdataStart = rdataStart;
			optRdataEnd = scanOff;
			break;
		}
	}

	if (optRdataStart >= 0) {
		let ecsStart = -1;
		let ecsEnd = -1;
		let rdataOff = optRdataStart;
		while (rdataOff + 4 <= optRdataEnd) {
			const optCode = readU16(buf, rdataOff);
			const optLen = readU16(buf, rdataOff + 2);
			const optDataEnd = rdataOff + 4 + optLen;
			if (optCode === 8) {
				ecsStart = rdataOff;
				ecsEnd = optDataEnd;
				break;
			}
			rdataOff = optDataEnd;
		}

		if (ecsStart >= 0) {
			const oldRdlength = readU16(buf, optRdlengthOffset);
			const newRdlength = oldRdlength - (ecsEnd - ecsStart) + ecsOption.length;
			const newMsg = concatBytes(buf.slice(0, ecsStart), ecsOption, buf.slice(ecsEnd));
			writeU16(newMsg, newRdlength, optRdlengthOffset);
			return newMsg;
		} else {
			const oldRdlength = readU16(buf, optRdlengthOffset);
			const newRdlength = oldRdlength + ecsOption.length;
			const newMsg = concatBytes(buf.slice(0, optRdataEnd), ecsOption, buf.slice(optRdataEnd));
			writeU16(newMsg, newRdlength, optRdlengthOffset);
			return newMsg;
		}
	} else {
		const optRecord = new Uint8Array(1 + 2 + 2 + 4 + 2 + ecsOption.length);
		let o = 0;
		optRecord[o++] = 0;
		writeU16(optRecord, 41, o); o += 2;
		writeU16(optRecord, 1232, o); o += 2;
		writeU32(optRecord, 0, o); o += 4;
		writeU16(optRecord, ecsOption.length, o); o += 2;
		optRecord.set(ecsOption, o);

		const newMsg = concatBytes(buf, optRecord);
		writeU16(newMsg, arcount + 1, 10);
		return newMsg;
	}
}

function formatClientSubnet(clientInfo) {
	const addrBytes = Math.ceil(clientInfo.prefix / 8);
	const subnet = clientInfo.bytes.slice(0, addrBytes);

	if (clientInfo.family === 1) {
		const parts = [];
		for (let i = 0; i < 4; i++) parts.push(subnet[i] || 0);
		return `${parts.join('.')}/${clientInfo.prefix}`;
	} else {
		const full = new Uint8Array(16);
		full.set(subnet);
		const parts = [];
		for (let i = 0; i < 8; i++) {
			parts.push(((full[i * 2] << 8) | full[i * 2 + 1]).toString(16));
		}
		return `${parts.join(':')}/${clientInfo.prefix}`;
	}
}

// ==================== ECH (Encrypted Client Hello) 支持 ====================

function buildSyntheticHTTPSResponse(query, echConfigB64, ttl = 300) {
	const buf = query instanceof Uint8Array ? query : new Uint8Array(query);
	const { questions, questionEnd } = parseQuestion(buf);
	if (questions.length === 0) return null;

	const echConfig = base64UrlToBytes(echConfigB64);
	if (echConfig.length === 0) return null;

	const echParam = new Uint8Array(4 + echConfig.length);
	writeU16(echParam, 9, 0);
	writeU16(echParam, echConfig.length, 2);
	echParam.set(echConfig, 4);

	const rdata = new Uint8Array(2 + 1 + echParam.length);
	writeU16(rdata, 1, 0);
	rdata[2] = 0;
	rdata.set(echParam, 3);

	const answer = new Uint8Array(2 + 2 + 2 + 4 + 2 + rdata.length);
	let a = 0;
	answer[a++] = 0xc0; answer[a++] = 0x0c;
	writeU16(answer, 65, a); a += 2;
	writeU16(answer, 1, a); a += 2;
	writeU32(answer, ttl, a); a += 4;
	writeU16(answer, rdata.length, a); a += 2;
	answer.set(rdata, a);

	const header = new Uint8Array(12);
	header[0] = buf[0]; header[1] = buf[1];
	writeU16(header, 0x8180, 2);
	writeU16(header, 1, 4);
	writeU16(header, 1, 6);
	writeU16(header, 0, 8);
	writeU16(header, 0, 10);

	const question = buf.slice(12, questionEnd);
	return concatBytes(header, question, answer);
}

function shouldInjectECH(qname, echDomains) {
	if (!echDomains || echDomains.length === 0) return true;
	const name = qname.toLowerCase().trim();
	return echDomains.some(d => name === d.toLowerCase().trim() || name.endsWith('.' + d.toLowerCase().trim()));
}

// ==================== DNS 错误响应 ====================

function buildErrorResponse(query, rcode) {
	const buf = query instanceof Uint8Array ? query : new Uint8Array(query);
	const { questionEnd } = parseQuestion(buf);

	const header = new Uint8Array(12);
	header[0] = buf[0]; header[1] = buf[1];
	writeU16(header, 0x8180 | (rcode & 0xf), 2);
	writeU16(header, readU16(buf, 4), 4);
	writeU16(header, 0, 6);
	writeU16(header, 0, 8);
	writeU16(header, 0, 10);

	return concatBytes(header, buf.slice(12, questionEnd));
}

// ==================== 上游管理 ====================

function getUpstreams(env) {
	const configured = env.UPSTREAMS;
	if (!configured) return UPSTREAM_CONFIGS;
	const names = configured.split(',').map(s => s.trim().toLowerCase());
	const filtered = UPSTREAM_CONFIGS.filter(u => names.includes(u.name));
	return filtered.length > 0 ? filtered : UPSTREAM_CONFIGS;
}

// 解析上游权重配置，如 "cloudflare:5,google:3,opendns:1,quad9:1"
function parseWeights(env) {
	const raw = env.WEIGHTS;
	if (!raw) return null;
	const w = {};
	for (const part of raw.split(',')) {
		const [name, weight] = part.trim().split(':');
		if (name && weight && !isNaN(parseInt(weight))) {
			w[name.trim().toLowerCase()] = Math.max(0, parseInt(weight));
		}
	}
	return w;
}
const cachedWeights = { raw: null, parsed: null };
function getWeightedPool(upstreams, env) {
	if (env.WEIGHTS !== cachedWeights.raw) {
		cachedWeights.raw = env.WEIGHTS;
		cachedWeights.parsed = parseWeights(env);
	}
	const weights = cachedWeights.parsed;
	if (!weights) return upstreams; // 无权重配置：保持原池
	const pool = [];
	for (const u of upstreams) {
		const w = weights[u.name];
		if (w === undefined || w === null) continue; // 未配置的上游不参与（更符合权重控制意图）
		for (let i = 0; i < w; i++) pool.push(u);
	}
	return pool.length > 0 ? pool : upstreams;
}

function selectUpstream(env) {
	const upstreams = getUpstreams(env);
	const now = Date.now();

	const healthy = upstreams.filter(u => {
		const h = upstreamHealth[u.name];
		return h.healthy || (now - h.lastError > 60000);
	});
	const basePool = healthy.length > 0 ? healthy : upstreams;
	// 套用权重
	const pool = getWeightedPool(basePool, env);

	const selected = pool[upstreamRRIndex % pool.length];
	upstreamRRIndex++;
	return selected;
}

function markSuccess(upstreamName, latency) {
	const h = upstreamHealth[upstreamName];
	h.healthy = true;
	h.consecutiveFailures = 0;
	stats.upstreamStats[upstreamName].queries++;
	stats.upstreamStats[upstreamName].totalLatency += latency;
}

function markFailure(upstreamName) {
	const h = upstreamHealth[upstreamName];
	h.consecutiveFailures++;
	h.lastError = Date.now();
	stats.upstreamStats[upstreamName].errors++;
	if (h.consecutiveFailures >= 3) {
		h.healthy = false;
	}
}

async function forwardWire(upstream, query, env) {
	const url = upstream.dohUrl;
	const startTime = Date.now();

	try {
		const response = await fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/dns-message',
				'Accept': 'application/dns-message',
			},
			body: query,
		});

		if (!response.ok) {
			throw new Error(`HTTP ${response.status} ${response.statusText}`);
		}

		const data = await response.arrayBuffer();
		const latency = Date.now() - startTime;
		markSuccess(upstream.name, latency);

		const respHeaders = new Headers();
		respHeaders.set('Content-Type', 'application/dns-message');
		respHeaders.set('Access-Control-Allow-Origin', '*');
		respHeaders.set('Access-Control-Expose-Headers', 'Content-Type, Content-Length');

		const ttl = extractMinTTL(new Uint8Array(data)) || 60;
		respHeaders.set('Cache-Control', `public, max-age=${ttl}`);

		return { data: new Uint8Array(data), headers: respHeaders, ttl, upstream: upstream.name, latency };
	} catch (err) {
		markFailure(upstream.name);
		throw err;
	}
}

async function forwardJSON(upstream, params, clientSubnet, env) {
	if (!upstream.jsonUrl) return null;
	const startTime = Date.now();

	const url = new URL(upstream.jsonUrl);
	for (const [key, value] of params) {
		url.searchParams.set(key, value);
	}
	if (clientSubnet && upstream.ecsSupported) {
		url.searchParams.set('edns_client_subnet', clientSubnet);
	}

	try {
		const response = await fetch(url.toString(), {
			headers: { 'Accept': 'application/dns-json' },
		});
		if (!response.ok) {
			throw new Error(`HTTP ${response.status} ${response.statusText}`);
		}
		const latency = Date.now() - startTime;
		markSuccess(upstream.name, latency);
		const json = await response.json();
		return { json, upstream: upstream.name, latency };
	} catch (err) {
		markFailure(upstream.name);
		throw err;
	}
}

function extractMinTTL(buf) {
	try {
		const ancount = readU16(buf, 6);
		if (ancount === 0) return 0;
		const { questionEnd } = parseQuestion(buf);
		let off = questionEnd;
		let minTTL = Infinity;
		for (let i = 0; i < ancount && off < buf.length; i++) {
			off = skipName(buf, off);
			off += 2;
			off += 2;
			const ttl = (buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3];
			off += 4;
			if (ttl < minTTL) minTTL = ttl;
			const rdlength = readU16(buf, off);
			off += 2 + rdlength;
		}
		return minTTL === Infinity ? 60 : Math.max(1, minTTL);
	} catch {
		return 60;
	}
}

// ==================== 缓存 ====================

async function getCacheKey(query, clientSubnet) {
	const { questions } = parseQuestion(query);
	if (questions.length === 0) return null;
	const q = questions[0];
	const keyStr = `${q.name.toLowerCase()}:${q.qtype}:${q.qclass}:${clientSubnet || 'none'}`;
	const hash = await sha256Hex(keyStr);
	return new Request(`https://cache.internal/v2/${hash}`);
}

async function getFromCache(cacheKey) {
	if (!cacheKey) return null;
	try {
		const cache = caches.default;
		return await cache.match(cacheKey);
	} catch { return null; }
}

async function putToCache(cacheKey, data, headers, ttl, ctx) {
	if (!cacheKey || ttl <= 0) return;
	try {
		const cache = caches.default;
		const newHeaders = new Headers(headers);
		newHeaders.set('Cache-Control', `public, max-age=${ttl}`);
		// Explicitly preserve Content-Type which was lost when spreading Headers as plain object
		if (!newHeaders.has('Content-Type')) newHeaders.set('Content-Type', 'application/dns-message');
		newHeaders.set('Access-Control-Allow-Origin', '*');
		newHeaders.set('Access-Control-Expose-Headers', 'Content-Type, Content-Length');
		const cached = new Response(data, {
			status: 200,
			headers: newHeaders,
		});
		ctx.waitUntil(cache.put(cacheKey, cached));
	} catch { }
}

// ==================== HTTP 请求处理 ====================

const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept',
	'Access-Control-Expose-Headers': 'Content-Type, Content-Length',
};

function checkAuth(request, url, env) {
	const token = env.TOKEN;
	if (!token) return true;
	const queryToken = url.searchParams.get('token');
	const authHeader = request.headers.get('Authorization');
	return queryToken === token || authHeader === `Bearer ${token}`;
}
function checkDashboardAuth(request, url, env) {
	const token = env.DASH_TOKEN || env.TOKEN || env.DASHBOARD_TOKEN;
	if (!token) return true;
	const queryToken = url.searchParams.get('token');
	const authHeader = request.headers.get('Authorization');
	if (queryToken === token || authHeader === `Bearer ${token}`) return true;
	// also check cookie
	const cookie = request.headers.get('Cookie') || '';
	if (cookie.includes(`dash_token=${token}`)) return true;
	return false;
}

function getClientIP(request) {
	return request.headers.get('CF-Connecting-IP') ||
		request.headers.get('True-Client-IP') ||
		request.headers.get('X-Real-IP') ||
		request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
		'';
}

function log(...args) {
	console.log(...args);
}

// 伪装 404 页面 — 不暴露任何信息
function fakeNotFound() {
	return new Response('<!DOCTYPE html><html><head><title>404 Not Found</title></head><body><center><h1>404 Not Found</h1></center><hr><center>nginx</center></body></html>', {
		status: 404,
		headers: {
			'Content-Type': 'text/html; charset=UTF-8',
			'Server': 'nginx',
		},
	});
}

/** 处理 wire format 请求 (GET + POST) */
async function handleSync(request, env, ctx) {
	const url = new URL(request.url);

	if (request.method === 'OPTIONS') {
		return new Response(null, { status: 204, headers: CORS_HEADERS });
	}

	if (!checkAuth(request, url, env)) {
		return fakeNotFound();
	}

	let query;
	if (request.method === 'GET') {
		const dnsParam = url.searchParams.get('dns');
		if (!dnsParam) {
			if (url.searchParams.has('name')) {
				return handleFetch(request, env, ctx);
			}
			return fakeNotFound();
		}
		query = base64UrlToBytes(dnsParam);
	} else if (request.method === 'POST') {
		const body = await request.arrayBuffer();
		query = new Uint8Array(body);
	} else {
		return fakeNotFound();
	}

	if (!query || query.length < 12) {
		return new Response('Bad Request', { status: 400, headers: CORS_HEADERS });
	}

	stats.totalQueries++;

	const { questions } = parseQuestion(query);
	const q = questions[0];
	if (q) {
		log(`Query: ${q.name} type=${q.qtype}`);
		addRecent(q.name, q.qtype, env, ctx, request);
	}

	const clientIP = getClientIP(request);
	const ecsEnabled = env.ECS !== 'false';
	let clientSubnet = null;
	let queryWithECS = query;

	if (ecsEnabled && clientIP) {
		const clientInfo = parseClientIP(clientIP);
		if (clientInfo) {
			const ipv4Prefix = parseInt(env.ECS_V4) || 24;
			const ipv6Prefix = parseInt(env.ECS_V6) || 56;
			queryWithECS = injectECS(query, clientIP, ipv4Prefix, ipv6Prefix);
			clientSubnet = formatClientSubnet({ ...clientInfo, prefix: clientInfo.family === 1 ? ipv4Prefix : ipv6Prefix });
			stats.ecsInjected++;
		}
	}

	// ECH 合成响应
	const echConfig = env.ECH_CONFIG;
	const echDomains = env.ECH_DOMAINS ? env.ECH_DOMAINS.split(',').map(s => s.trim()).filter(Boolean) : [];
	const echTTL = parseInt(env.ECH_TTL) || 300;

	if (echConfig && q && q.qtype === 65) {
		if (shouldInjectECH(q.name, echDomains)) {
			const synthetic = buildSyntheticHTTPSResponse(queryWithECS, echConfig, echTTL);
			if (synthetic) {
				stats.echServed++;
				return new Response(synthetic, {
					status: 200,
					headers: {
						'Content-Type': 'application/dns-message',
						'Cache-Control': `public, max-age=${echTTL}`,
						...CORS_HEADERS,
					},
				});
			}
		}
	}

	// 缓存
	const cacheKey = await getCacheKey(query, clientSubnet);
	const cached = await getFromCache(cacheKey);
	if (cached) {
		stats.cacheHits++;
		recordRate('__cache__', true);
		writeAnalytics(env, ctx, { colo: request.cf && request.cf.colo, upstream: 'cache', domain: q && q.name, cache: true });
		const headers = new Headers(cached.headers);
		Object.entries(CORS_HEADERS).forEach(([k, v]) => headers.set(k, v));
		return new Response(cached.body, { status: 200, headers });
	}
	stats.cacheMisses++;
	recordRate('__pending__', false);

	// 转发 (带故障转移)
	const upstreams = getUpstreams(env);
	const maxRetries = upstreams.length;
	let lastError = null;
	let result = null;

	for (let attempt = 0; attempt < maxRetries; attempt++) {
		const upstream = attempt === 0 ? selectUpstream(env) : upstreams[(upstreamRRIndex + attempt) % upstreams.length];
		try {
			result = await forwardWire(upstream, queryWithECS, env);
			break;
		} catch (err) {
			lastError = err;
		}
	}

	if (!result) {
		const servfail = buildErrorResponse(query, 2);
		recordRate('__fail__', false);
		writeAnalytics(env, ctx, { colo: request.cf && request.cf.colo, upstream: 'fail', domain: q && q.name, cache: false });
		return new Response(servfail, {
			status: 200,
			headers: {
				'Content-Type': 'application/dns-message',
				'Cache-Control': 'no-store',
				...CORS_HEADERS,
			},
		});
	}

	recordRate(result.upstream, false);
	writeAnalytics(env, ctx, { colo: request.cf && request.cf.colo, upstream: result.upstream, domain: q && q.name, cache: false });
	const cacheTTL = Math.min(result.ttl, parseInt(env.CACHE_TTL) || 60);
	if (cacheTTL > 0) {
		await putToCache(cacheKey, result.data, result.headers, cacheTTL, ctx);
	}

	const responseHeaders = new Headers(result.headers);
	Object.entries(CORS_HEADERS).forEach(([k, v]) => responseHeaders.set(k, v));

	return new Response(result.data, { status: 200, headers: responseHeaders });
}

/** 处理 JSON 请求 */
async function handleFetch(request, env, ctx) {
	const url = new URL(request.url);

	if (request.method === 'OPTIONS') {
		return new Response(null, { status: 204, headers: CORS_HEADERS });
	}

	if (!checkAuth(request, url, env)) {
		return fakeNotFound();
	}

	const name = url.searchParams.get('name');
	if (!name) {
		return new Response(JSON.stringify({ error: 'Missing "name" parameter' }), {
			status: 400,
			headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
		});
	}

	const type = url.searchParams.get('type') || 'A';
	stats.totalQueries++;
	const _qt = ({ 'A': 1, 'AAAA': 28, 'CNAME': 5, 'MX': 15, 'TXT': 16, 'NS': 2, 'HTTPS': 65, 'SVCB': 64 }[type.toUpperCase()] || type);
	addRecent(name, _qt, env, ctx, request);

	const clientIP = getClientIP(request);
	const ecsEnabled = env.ECS !== 'false';
	let clientSubnet = null;

	if (ecsEnabled && clientIP) {
		const clientInfo = parseClientIP(clientIP);
		if (clientInfo) {
			const ipv4Prefix = parseInt(env.ECS_V4) || 24;
			const ipv6Prefix = parseInt(env.ECS_V6) || 56;
			clientInfo.prefix = clientInfo.family === 1 ? ipv4Prefix : ipv6Prefix;
			clientSubnet = formatClientSubnet(clientInfo);
			stats.ecsInjected++;
		}
	}

	const params = new URLSearchParams();
	params.set('name', name);
	params.set('type', type);
	if (url.searchParams.has('do')) params.set('do', url.searchParams.get('do'));
	if (url.searchParams.has('cd')) params.set('cd', url.searchParams.get('cd'));
	if (url.searchParams.has('ct')) params.set('ct', url.searchParams.get('ct'));

	const upstreams = getUpstreams(env).filter(u => u.jsonUrl);
	if (upstreams.length === 0) {
		return new Response(JSON.stringify({ error: 'No upstream available' }), {
			status: 502,
			headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
		});
	}

	let lastError = null;
	let result = null;

	for (let attempt = 0; attempt < upstreams.length; attempt++) {
		const upstream = upstreams[(upstreamRRIndex + attempt) % upstreams.length];
		try {
			result = await forwardJSON(upstream, params, clientSubnet, env);
			break;
		} catch (err) {
			lastError = err;
		}
	}

	if (!result) {
		return new Response(JSON.stringify({ error: 'All upstreams failed', detail: lastError?.message }), {
			status: 502,
			headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
		});
	}

	return new Response(JSON.stringify(result.json), {
		status: 200,
		headers: {
			'Content-Type': 'application/dns-json',
			'Access-Control-Allow-Origin': '*',
		},
	});
}

/** 统计信息 */
async function handleInfo(request, env) {
	if (!checkDashboardAuth(request, new URL(request.url), env)) {
		return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer' } });
	}
	const uptime = Math.floor((Date.now() - stats.startTime) / 1000);
	const upstreamDetails = {};
	for (const [name, s] of Object.entries(stats.upstreamStats)) {
		upstreamDetails[name] = {
			label: (UPSTREAM_CONFIGS.find(u => u.name === name) || {}).label || '',
			queries: s.queries,
			errors: s.errors,
			avgLatency: s.queries > 0 ? Math.round(s.totalLatency / s.queries) : 0,
			healthy: upstreamHealth[name].healthy,
		};
	}
	let recentRaw = recentQueries.slice();
	let recentCount = recentQueries.length;
	if (env && env.RECENT_KV) {
		try {
			const raw = await env.RECENT_KV.get('recent');
			if (raw) {
				const kvList = JSON.parse(raw);
				recentRaw = kvList;
				recentCount = kvList.length;
			}
		} catch {}
	}
	// 兼容旧字符串格式 -> 统一为对象 {c,n,t,ts}
	function normalize(e){
		if (typeof e === 'string') {
			const m = e.match(/^(.*)\(([^)]+)\)$/);
			return { c: 'UNKNOWN', n: m ? m[1] : e, t: m ? m[2] : '', ts: 0 };
		}
		return e;
	}
	const normalized = recentRaw.map(normalize);
	// 分区：按边缘节点，聚合域名 -> {count, types, lastTs}
	const byColo = {};
	const domainsByColo = {};
	for (const r of normalized) {
		const colo = r.c || 'UNKNOWN';
		if (!byColo[colo]) byColo[colo] = [];
		byColo[colo].push(r);
		if (!domainsByColo[colo]) domainsByColo[colo] = {};
		const dm = domainsByColo[colo];
		if (!dm[r.n]) dm[r.n] = { count: 0, types: {}, lastTs: 0 };
		dm[r.n].count++;
		if (r.t) dm[r.n].types[r.t] = (dm[r.n].types[r.t] || 0) + 1;
		if (r.ts && r.ts > dm[r.n].lastTs) dm[r.n].lastTs = r.ts;
	}
	// 降序排列域名
	for (const colo of Object.keys(domainsByColo)) {
		const entries = Object.entries(domainsByColo[colo]);
		entries.sort((a, b) => b[1].count - a[1].count);
		domainsByColo[colo] = entries.map(([name, info]) => ({ name, ...info }));
	}
	// recent 倒序（最新在前）供旧面板兼容 - 不带 @COLO
	const recent = normalized.slice().reverse().map(r => `${r.n}(${r.t})`);
	const recentDetailed = normalized.slice().reverse();
	const rates = computeRates();
	// 全局 QPS（Analytics Engine）
	let global = null;
	if (env && env.ANALYTICS) {
		global = await queryGlobalQPS(env);
	}
	return new Response(JSON.stringify({
		uptime,
		totalQueries: stats.totalQueries,
		cacheHits: stats.cacheHits,
		cacheMisses: stats.cacheMisses,
		cacheHitRate: stats.totalQueries > 0 ? (stats.cacheHits / stats.totalQueries * 100).toFixed(1) + '%' : '0%',
		ecsInjected: stats.ecsInjected,
		echServed: stats.echServed,
		upstreams: upstreamDetails,
		recent,
		recentCount,
		recentByColo: byColo,
		recentDetailed,
		domainsByColo,
		rate: {
			qps1: rates.qps1.toFixed(2),
			qps5: rates.qps5.toFixed(2),
			total1: rates.total1,
			total5: rates.total5,
			hitRate1: rates.hitRate1.toFixed(1) + '%',
			hitRate5: rates.hitRate5.toFixed(1) + '%',
			byUpstream1: rates.byUpstream1,
			byUpstream5: rates.byUpstream5,
		},
		globalQps: global ? global.qps60 : null,
		globalTotal60: global ? global.total60 : null,
		globalTotal300: global ? global.total300 : null,
		globalByUpstream: global ? global.byUpstream : null,
		globalCacheRate: global ? global.cacheHitRate : null,
		weights: env.WEIGHTS || '',
	}, null, 2), {
		status: 200,
		headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
	});
}

/** 上游健康检查 */
async function handleMonitor(request, env) {
	if (!checkDashboardAuth(request, new URL(request.url), env)) {
		return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer' } });
	}
	const upstreams = getUpstreams(env);
	const results = [];

	for (const u of upstreams) {
		const h = upstreamHealth[u.name];
		const s = stats.upstreamStats[u.name];
		results.push({
			name: u.name,
			label: u.label,
			healthy: h.healthy,
			consecutiveFailures: h.consecutiveFailures,
			lastError: h.lastError ? new Date(h.lastError).toISOString() : null,
			queries: s.queries,
			errors: s.errors,
			avgLatency: s.queries > 0 ? Math.round(s.totalLatency / s.queries) : 0,
		});
	}

	return new Response(JSON.stringify(results, null, 2), {
		status: 200,
		headers: { 'Content-Type': 'application/json' },
	});
}

/** ECH 配置 */
async function handleKey(env) {
	if (!env.ECH_CONFIG) {
		return fakeNotFound();
	}
	return new Response(env.ECH_CONFIG, {
		status: 200,
		headers: { 'Content-Type': 'text/plain; charset=utf-8' },
	});
}

/**
 * 状态面板 v2：分区视角 + 上游视角
 */
async function handleDashboard(request, env) {
	const url = new URL(request.url);
	if (!checkDashboardAuth(request, url, env)) {
		const html401 = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Auth Required</title><style>body{font-family:system-ui;background:#0f1117;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0} .box{background:#1a1d27;border:1px solid #2a2d3a;border-radius:12px;padding:24px;max-width:400px;width:90%} input{width:100%;padding:10px;border-radius:8px;border:1px solid #2a2d3a;background:#0f1117;color:#e4e4e7;margin:12px 0} button{width:100%;padding:10px;border-radius:8px;border:none;background:#3b82f6;color:#fff;cursor:pointer} .muted{color:#71717a;font-size:0.8rem}</style></head><body><div class="box"><h3>鉴权 Required</h3><p class="muted">请输入面板访问令牌</p><input id="t" placeholder="token" type="password"><button onclick="var v=document.getElementById('t').value;if(!v)return alert('请输入');document.cookie='dash_token='+v+';path=/;max-age=86400';location.href=location.pathname+'?token='+encodeURIComponent(v)">进入</button><p class="muted" style="margin-top:10px">URL 加 <code>?token=</code> 或 Header <code>Authorization: Bearer</code></p></div></body></html>`;
		return new Response(html401, { status: 401, headers: { 'Content-Type': 'text/html; charset=UTF-8', 'Cache-Control': 'no-store' } });
	}
	const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>API Gateway</title>
<style>
:root { --bg:#0f1117; --card:#1a1d27; --border:#2a2d3a; --text:#e4e4e7; --muted:#71717a; --accent:#3b82f6; --green:#22c55e; --red:#ef4444; --amber:#f59e0b; }
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--text);line-height:1.5}
.wrap{max-width:1200px;margin:0 auto;padding:20px}
h1{font-size:1.5rem;margin-bottom:4px}
.sub{color:var(--muted);font-size:0.85rem;margin-bottom:16px}
.badge{display:inline-block;font-size:0.7rem;padding:1px 8px;border-radius:999px;border:1px solid var(--border);color:var(--muted);margin-left:6px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:12px;margin-bottom:20px}
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:14px}
.card .l{font-size:0.68rem;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}
.card .v{font-size:1.35rem;font-weight:700;margin-top:4px}
.card .s{font-size:0.72rem;color:var(--muted);margin-top:2px}
.tabs{display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap}
.tab{background:var(--card);border:1px solid var(--border);color:var(--muted);border-radius:10px;padding:8px 14px;cursor:pointer;font-size:0.85rem}
.tab.active{color:#fff;border-color:var(--accent);background:#1e3a5f}
.tab .n{font-weight:700;color:#fff;margin-left:6px}
.panel{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px;margin-bottom:16px}
.panel h2{font-size:1.05rem;margin-bottom:12px}
.row2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:860px){.row2{grid-template-columns:1fr}}
table{width:100%;border-collapse:collapse;font-size:0.86rem}
th,td{padding:8px 12px;text-align:left;border-bottom:1px solid var(--border)}
th{font-size:0.7rem;color:var(--muted);text-transform:uppercase}
.bar{height:6px;background:#0f1117;border-radius:999px;overflow:hidden;min-width:60px}
.bar>i{display:block;height:100%;background:var(--accent)}
.tag{display:inline-block;font-size:0.66rem;padding:1px 8px;border-radius:999px;background:#1e293b;border:1px solid #334155;color:#7dd3fc;margin-right:6px}
.type{display:inline-block;font-size:0.66rem;padding:1px 6px;border-radius:999px;background:#1f2937;border:1px solid #2a2d3a;color:#93c5fd;margin-left:4px}
.q{font-family:ui-monospace,monospace;font-size:0.78rem}
.muted{color:var(--muted)}
.scroll{max-height:480px;overflow:auto;border:1px solid var(--border);border-radius:10px;background:#0b0d12}
.item{display:flex;justify-content:space-between;align-items:center;padding:7px 12px;border-bottom:1px solid #171a24;font-size:0.82rem}
.item:last-child{border-bottom:none}
.btn{background:var(--card);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:5px 10px;font-size:0.78rem;cursor:pointer}
.btn:hover{border-color:var(--accent)}
.search{background:#0f1117;border:1px solid var(--border);color:var(--text);border-radius:8px;padding:5px 10px;font-size:0.8rem;width:200px}
.hdr{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px}
.ok{color:var(--green)} .err{color:var(--red)}
</style>
</head>
<body>
<div class="wrap">
	<h1>API Gateway <span class="badge" id="colo">-</span><span class="badge" id="now">-</span></h1>
	<p class="sub">DoH 转发 · ECS · ECH · 多上游</p>

	<div class="grid">
		<div class="card"><div class="l">总请求</div><div class="v" id="total">-</div><div class="s" id="totalSub">-</div></div>
		<div class="card"><div class="l">全局 QPS</div><div class="v" id="gqps">-</div><div class="s" id="gqpsSub">Analytics Engine 跨节点</div></div>
		<div class="card"><div class="l">QPS (1min)</div><div class="v" id="qps1">-</div><div class="s" id="qps1Sub">-</div></div>
		<div class="card"><div class="l">QPS (5min)</div><div class="v" id="qps5">-</div><div class="s" id="qps5Sub">-</div></div>
		<div class="card"><div class="l">缓存命中</div><div class="v" id="hit">-</div><div class="s">1min / 5min 命中率</div></div>
		<div class="card"><div class="l">ECS 注入</div><div class="v" id="ecs">-</div><div class="s">EDNS Client Subnet</div></div>
		<div class="card"><div class="l">ECH 响应</div><div class="v" id="ech">-</div><div class="s">HTTPS SVCB</div></div>
		<div class="card"><div class="l">运行时长</div><div class="v" id="uptime">-</div><div class="s" id="uptimeSub">-</div></div>
	</div>

	<div class="tabs" id="coloTabs"></div>

	<div class="row2">
		<div class="panel">
			<div class="hdr">
				<h2 style="margin:0" id="p1Title">分区域名</h2>
				<div style="display:flex;gap:6px">
					<input id="search" class="search" placeholder="过滤域名…">
				</div>
			</div>
			<div class="scroll" id="domainList" style="max-height:420px"><div class="muted" style="padding:12px">加载中…</div></div>
		</div>
		<div class="panel">
			<div class="hdr"><h2 style="margin:0">最近解析</h2><button class="btn" onclick="copyRecent()">复制</button></div>
			<div class="scroll" id="recentList"><div class="muted" style="padding:12px">加载中…</div></div>
		</div>
	</div>

	<div class="panel">
		<div class="hdr"><h2 style="margin:0">分区 Top 榜</h2><span class="muted" id="topNote">-</span></div>
		<div class="scroll" id="topList" style="max-height:300px"><div class="muted" style="padding:12px">加载中…</div></div>
	</div>

	<div class="panel">
		<h2>Upstreams（边缘节点视角）</h2>
		<table>
			<thead><tr><th>上游</th><th>状态</th><th>调用次数</th><th>错误</th><th>平均延迟</th><th>1min 占比</th><th>成功率</th></tr></thead>
			<tbody id="upBody"></tbody>
		</table>
		<div class="muted" style="margin-top:8px" id="upNote">调用统计基于各边缘节点内存样本，重启/换节点会归零。</div>
	</div>
</div>
<script>
function getDashToken(){
  const u=new URLSearchParams(location.search).get('token');
  if(u){localStorage.setItem('dash_token',u);document.cookie='dash_token='+u+';path=/;max-age=86400';return u;}
  const m=document.cookie.match(/dash_token=([^;]+)/); if(m) return m[1];
  return localStorage.getItem('dash_token')||'';
}
const TOK=getDashToken();
function af(u,o){o=o||{};if(TOK){const s=u.includes('?')?'&':'?';u+=s+'token='+encodeURIComponent(TOK);o.headers=Object.assign({},o.headers,{Authorization:'Bearer '+TOK});}return fetch(u,o);}
function fmtUptime(s){const h=Math.floor(s/3600),m=Math.floor(s%3600/60),x=s%60;return h>0?h+'h '+m+'m '+x+'s':m+'m '+x+'s';}
let curColo=''; let allD=[]; let allDomains={};
let state={};
function renderTabs(state){
  const dom=Object.keys(state.domainsByColo||{});
  const tab=document.getElementById('coloTabs');
  tab.innerHTML=dom.length?'': '<div class="muted" style="padding:6px">无数据</div>';
  dom.sort().forEach(c=>{
    const cnt=state.domainsByColo[c].length;
    const b=document.createElement('button');
    b.className='tab'+(c===curColo?' active':'');
    b.innerHTML=c+'<span class="n">'+cnt+'</span>';
    b.onclick=()=>{curColo=c;renderTabs(state);renderDomainList(state);};
    tab.appendChild(b);
  });
}
function renderDomainList(state){
  const q=document.getElementById('search').value.trim().toLowerCase();
  const doms=state.domainsByColo?.[curColo]||[];
  const list=document.getElementById('domainList');
  const p1t=document.getElementById('p1Title');
  p1t.textContent='分布：'+curColo+'（'+doms.length+' 域名）';
  let arr=doms.slice();
  if(q) arr=arr.filter(d=>d.name.toLowerCase().includes(q));
  if(arr.length===0){list.innerHTML='<div class="muted" style="padding:12px">无</div>';return;}
  const max=arr[0].count||1;
  list.innerHTML=arr.slice(0,200).map(d=>{
    const types=Object.entries(d.types||{}).map(([k,v])=>'<span class="type">'+k+' '+v+'</span>').join('');
    const pct=Math.round((d.count||0)/max*100);
    return '<div class="item"><div><span class="q">'+d.name+'</span>'+types+'</div><div style="display:flex;align-items:center;gap:8px"><span class="bar" style="width:90px"><i style="width:'+pct+'%"></i></span><span class="muted" style="font-size:0.72rem">'+d.count+'x'+(d.lastTs?' · '+new Date(d.lastTs).toLocaleTimeString():'')+'</span></div></div>';
  }).join('');
}
function renderRecent(state){
  const rec=document.getElementById('recentList');
  const arr=(state.recentDetailed||[]);
  if(arr.length===0){rec.innerHTML='<div class="muted" style="padding:12px">无数据</div>';return;}
  rec.innerHTML=arr.slice(0,150).map(r=>{
    const time=r.ts?new Date(r.ts).toLocaleTimeString()+' '+new Date(r.ts).toLocaleDateString():'';
    return '<div class="item"><div><span class="tag">'+r.c+'</span><span class="q">'+r.n+'</span><span class="type">'+r.t+'</span></div><span class="muted" style="font-size:0.7rem">'+time+'</span></div>';
  }).join('');
}
function renderTop(state){
  const tops=document.getElementById('topList');
  const cols=Object.keys(state.domainsByColo||{});
  if(cols.length===0){tops.innerHTML='<div class="muted" style="padding:12px">无数据</div>';document.getElementById('topNote').textContent='-';return;}
  let html='';
  const perColo={};
  let grandTotal=0;
  for(const c of cols){
    perColo[c]=(state.domainsByColo[c]||[]).slice(0,10); // top10 每分区
    grandTotal += (state.domainsByColo[c]||[]).length;
  }
  document.getElementById('topNote').textContent='每分区 Top10 · '+cols.length+' 分区';
  for(const c of cols){
    const arr=perColo[c];
    if(!arr.length) continue;
    html+='<div style="padding:8px 12px;background:#1a1d27;border-bottom:1px solid var(--border);font-size:0.8rem;font-weight:600"><span class="tag">'+c+'</span> Top 10</div>';
    const max=arr[0].count||1;
    html+=arr.slice(0,10).map((d,i)=>{
      const pct=Math.round(d.count/max*100);
      return '<div class="item"><div><span class="muted" style="font-size:0.7rem;width:20px;display:inline-block">'+(i+1)+'.</span><span class="q">'+d.name+'</span></div><div style="display:flex;align-items:center;gap:8px"><span class="bar" style="width:80px"><i style="width:'+pct+'%"></i></span><span class="muted" style="font-size:0.72rem">'+d.count+'x</span></div></div>';
    }).join('');
  }
  tops.innerHTML=html;
}
function renderUp(state){
  const tbody=document.getElementById('upBody');
  tbody.innerHTML=(state.upstreams?Object.entries(state.upstreams):[]).map(([name,u])=>{
    const b1=state.rate?.byUpstream1||{};
    const b5=state.rate?.byUpstream5||{};
    const tot1=state.rate?.total1||0;
    const pct=tot1?Math.round((b1[name]||0)/tot1*100):0;
    const sr=u.queries?Math.round((u.queries-u.errors)/u.queries*100):100;
    return '<tr><td><span class="q">'+name+'</span><span class="muted" style="font-size:0.7rem"> · '+u.label+'</span></td><td><span class="'+(u.healthy?'ok':'err')+'">'+(u.healthy?'● OK':'● 异常')+'</span></td><td>'+u.queries+'</td><td>'+u.errors+'</td><td>'+u.avgLatency+'ms</td><td><div style="display:flex;align-items:center;gap:8px"><span class="bar" style="width:70px"><i style="width:'+pct+'%"></i></span><span class="muted">'+pct+'%</span></div></td><td>'+sr+'%</td></tr>';
  }).join('');
  const w=state.weights?' · 权重 '+state.weights:''; document.getElementById('upNote').textContent='1min 总请求 '+state.rate?.total1+' · 5min '+state.rate?.total5+' · 缓存命中 '+state.rate?.hitRate1+'(1m) / '+state.rate?.hitRate5+'(5m) · 上游调用为各边缘节点内存样本'+w;
}
function copyRecent(){
  const arr=state.recentDetailed||[];
  const t=arr.map(r=>r.n+' ('+r.t+') ['+r.c+']').join(String.fromCharCode(10));
  navigator.clipboard.writeText(t).then(()=>alert('已复制 '+arr.length+' 条'));
}
document.getElementById('search').addEventListener('input',()=>renderDomainList(state));
async function refresh(){
  try{
    const s=await af('/info').then(r=>{if(r.status===401)throw Error('401');return r.json()});
    state=s;
    document.getElementById('total').textContent=s.totalQueries;
    document.getElementById('totalSub').textContent=s.cacheHits+' hit / '+s.cacheMisses+' miss';
    document.getElementById('gqps').textContent=(s.globalQps!=null)?s.globalQps+'/s':'-';
    document.getElementById('gqpsSub').textContent='60s '+s.globalTotal60+' 请求 · 缓存 '+s.globalCacheRate;
    document.getElementById('qps1').textContent=s.rate?.qps1+'/s';
    document.getElementById('qps1Sub').textContent='1min '+s.rate?.total1+' 请求';
    document.getElementById('qps5').textContent=s.rate?.qps5+'/s';
    document.getElementById('qps5Sub').textContent='5min '+s.rate?.total5+' 请求';
    document.getElementById('hit').textContent=s.rate?.hitRate1;
    document.getElementById('ecs').textContent=s.ecsInjected;
    document.getElementById('ech').textContent=s.echServed;
    document.getElementById('uptime').textContent=fmtUptime(s.uptime);
    document.getElementById('uptimeSub').textContent='启动于 '+new Date(s.startTime||Date.now()-s.uptime*1000).toLocaleString();
    document.getElementById('now').textContent=new Date().toLocaleTimeString();
    try{const ray=(await af('/monitor')).headers.get('cf-ray');document.getElementById('colo').textContent=(ray||'').split('-').pop()||'edge';}catch{}
    if(!curColo){const dom=Object.keys(s.domainsByColo||{});curColo=dom[0]||'';}
    renderTabs(s);renderDomainList(s);renderRecent(s);renderUp(s);renderTop(s);
  }catch(e){
    if(String(e).includes('401')){document.body.innerHTML='<div style="display:flex;height:100vh;align-items:center;justify-content:center;background:#0f1117;color:#e4e4e7"><div>鉴权失败，请用 ?token= 访问</div></div>';}
    console.error(e);
  }
}
refresh();setInterval(refresh,5000);
</script>
</body>
</html>`;
	return new Response(html, {
		status: 200,
		headers: { 'Content-Type': 'text/html; charset=UTF-8', 'Cache-Control': 'no-store' },
	});
}

// ==================== 主入口 ====================

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		const path = url.pathname;

		// /sync 和 /dns-query — wire format (GET + POST)
		// /dns-query 是浏览器(Chrome/Firefox) DoH 强制要求的标准路径, 必须保留
		if (path === '/sync' || path === '/dns-query' || path === '/doh/query') {
			return handleSync(request, env, ctx);
		}
		// /fetch — JSON API
		if (path === '/fetch') {
			return handleFetch(request, env, ctx);
		}
		// /info — stats (需鉴权)
		if (path === '/info') {
			return handleInfo(request, env);
		}
		// /monitor — health (需鉴权)
		if (path === '/monitor') {
			return handleMonitor(request, env);
		}
		// /key — ECH config
		if (path === '/key') {
			return handleKey(env);
		}
		// / — dashboard (需鉴权)
		if (path === '/' || path === '/index.html') {
			return handleDashboard(request, env);
		}
		// 其余路径返回伪装 404
		return fakeNotFound();
	},
};
