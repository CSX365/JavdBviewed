// 页面侧 seed 逻辑（纯 JS，经 page.evaluate 字符串注入，避免 tsx 转换引入 __name helper）
// 约束：必须保持「单个 async (args) => {...} 表达式」，Playwright 会包成 (表达式)(arg) 调用
async (args) => {
  const { reset: doReset, targets, media, settings: settingsPayload } = args;

  // 确定性伪随机（与主脚本同种子口径，保证重跑幂等可收敛）
  const mulberry32 = (seed) => {
    let a = seed >>> 0;
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  // ---- 等待 SW 建库（viewedRecords 就绪），复刻 E2E 重试口径 ----
  const openDb = () => new Promise((resolve, reject) => {
    let attempts = 0;
    const attempt = () => {
      attempts += 1;
      const request = indexedDB.open('javdb_v1', 14);
      request.onsuccess = () => {
        const db = request.result;
        if (db.objectStoreNames.contains('viewedRecords') &&
            db.objectStoreNames.contains('newWorks') &&
            db.objectStoreNames.contains('actors')) {
          resolve(db);
        } else if (attempts < 60) {
          db.close();
          window.setTimeout(attempt, 1000);
        } else {
          db.close();
          reject(new Error('javdb_v1 stores 未就绪（60 次重试后）'));
        }
      };
      request.onerror = () => reject(request.error || new Error('open javdb_v1 failed'));
      request.onupgradeneeded = () => { if (request.transaction) request.transaction.abort(); };
    };
    attempt();
  });

  const db = await openDb();
  const countStore = (name) => new Promise((resolve, reject) => {
    const req = db.transaction(name, 'readonly').objectStore(name).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error(`count ${name} failed`));
  });
  const clearStore = (name) => new Promise((resolve, reject) => {
    const tx = db.transaction(name, 'readwrite');
    tx.objectStore(name).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error(`clear ${name} failed`));
  });
  const putBatch = (name, rows) => new Promise((resolve, reject) => {
    const tx = db.transaction(name, 'readwrite');
    const store = tx.objectStore(name);
    for (const row of rows) store.put(row);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error(`put ${name} batch failed`));
  });

  const before = {
    viewed: await countStore('viewedRecords'),
    newWorks: await countStore('newWorks'),
    actors: await countStore('actors'),
  };

  let alreadySeeded = false;
  if (doReset) {
    await Promise.all(['viewedRecords', 'newWorks', 'actors'].map(clearStore));
  } else if (before.viewed >= targets.viewedTotal - 10) {
    alreadySeeded = true;
  }

  if (!alreadySeeded) {
    const rand = mulberry32(20260906);
    const now = Date.now();
    const DAY = 86400000;

    // ---- 演员池（50 人，3 黑名单；明显虚构的名字）----
    const surnamePool = ['藤原', '桜井', '高橋', '佐藤', '三上', '宮本', '小林', '山田', '石川', '中村'];
    const givenPool = ['澪', '結愛', '彩花', '日向', '美桜', '凛音', '七海', '千歌', '若葉', '遥香'];
    const actors = [];
    for (let i = 0; i < targets.actors; i += 1) {
      const name = `${surnamePool[i % surnamePool.length]}${givenPool[Math.floor(i / surnamePool.length) % givenPool.length]}${i >= 100 ? i : ''}`;
      const createdAt = now - Math.floor(rand() * 500 + 10) * DAY;
      actors.push({
        id: `PERFA${String(i).padStart(2, '0')}`,
        name,
        aliases: [name],
        gender: i % 10 === 0 ? 'male' : 'female',
        category: 'unknown',
        profileUrl: '',
        createdAt,
        updatedAt: createdAt + Math.floor(rand() * 30) * DAY,
        blacklisted: i < targets.actorsBlacklisted,
      });
    }
    await putBatch('actors', actors);

    // ---- 番号库 20000 条（前 3000 条与媒体库番号重合，保证库匹配标签命中）----
    const prefixes = ['SSIS', 'STARS', 'JUL', 'MIDE', 'ABP', 'RISU', 'ZIZI', 'MMN', 'KAWD', 'VSD', 'FNS', 'SDJS', 'START', 'LUXU', 'ROE', 'PREDU', 'DAS', 'OFF', 'ZANR', 'JGM'];
    const usedCodes = new Set();
    const makeCover = (i) => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="160"><rect width="120" height="160" fill="hsl(${(i * 137) % 360},40%,60%)"/></svg>`;
      return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
    };
    const rows = [];
    for (let i = 0; i < targets.viewedTotal; i += 1) {
      let status;
      if (i < targets.viewed) status = 'viewed';
      else if (i < targets.viewed + targets.browsed) status = 'browsed';
      else if (i < targets.viewed + targets.browsed + targets.want) status = 'want';
      else status = 'untracked';

      let code;
      if (i < targets.mediaLibrary) {
        code = `PERF-${String(i + 1).padStart(4, '0')}`;
      } else {
        for (let tries = 0; ; tries += 1) {
          const candidate = `${prefixes[Math.floor(rand() * prefixes.length)]}-${String(Math.floor(rand() * 900) + 100)}${rand() < 0.4 ? String(Math.floor(rand() * 10)) : ''}`;
          if (!usedCodes.has(candidate)) { code = candidate; break; }
          if (tries > 50) { code = `PERFX-${i}`; break; }
        }
      }
      usedCodes.add(code);

      const releaseMs = new Date(2015, 0, 1).getTime() + Math.floor(rand() * (now - new Date(2015, 0, 1).getTime()));
      const createdAt = releaseMs + Math.floor(rand() * 400) * DAY;
      const updatedAt = Math.min(now, createdAt + Math.floor(rand() * 500) * DAY);
      const actorCount = 1 + Math.floor(rand() * 2);
      const actorNames = [];
      for (let a = 0; a < actorCount; a += 1) actorNames.push(actors[Math.floor(rand() * actors.length)].name);

      const row = {
        id: code,
        title: `${code} Seed 影片 ${i + 1}`,
        status,
        createdAt,
        updatedAt,
        releaseDate: new Date(releaseMs).toISOString().slice(0, 10),
        javdbUrl: '',
        coverImage: makeCover(i),
        actors: actorNames,
        videoCode: code,
        rating: Math.round((5 + rand() * 4.5) * 10) / 10,
      };
      if (i < targets.favorites) {
        row.isFavorite = true;
        row.favoritedAt = updatedAt;
        row.favoriteIndexed = updatedAt;
      }
      rows.push(row);
    }
    const VIEWED_CHUNK = 2000;
    for (let start = 0; start < rows.length; start += VIEWED_CHUNK) {
      await putBatch('viewedRecords', rows.slice(start, start + VIEWED_CHUNK));
    }

    // ---- 新作品 2000 条（未读 1800）----
    const nwRows = [];
    for (let i = 0; i < targets.newWorks; i += 1) {
      const actor = actors[Math.floor(rand() * actors.length)];
      const discoveredAt = now - Math.floor(rand() * 30) * DAY;
      nwRows.push({
        id: `PERFNW-${String(i).padStart(5, '0')}`,
        actorId: actor.id,
        actorName: actor.name,
        title: `Seed 新作品 ${i + 1}`,
        releaseDate: new Date(discoveredAt - 86400000).toISOString().slice(0, 7),
        javdbUrl: '',
        tags: [],
        discoveredAt,
        isRead: i < targets.newWorksRead,
        status: 'new',
      });
    }
    const NW_CHUNK = 1000;
    for (let start = 0; start < nwRows.length; start += NW_CHUNK) {
      await putBatch('newWorks', nwRows.slice(start, start + NW_CHUNK));
    }
  }

  // ---- storage：设置 + 媒体库状态（无论是否已 seed 都重写，保证口径一致）----
  await new Promise((resolve, reject) => {
    chrome.storage.local.set(
      {
        settings: settingsPayload,
        emby_library_state: media.emby_library_state,
        drive115_library_state: media.drive115_library_state,
      },
      () => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(`storage.local.set failed: ${err.message}`));
        else resolve();
      },
    );
  });

  // ---- 读回校验：单次游标遍历统计 total/byStatus/favorites ----
  const stats = await new Promise((resolve, reject) => {
    const cursorReq = db.transaction('viewedRecords', 'readonly').objectStore('viewedRecords').openCursor();
    let total = 0;
    let favorites = 0;
    const byStatus = {};
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor) { resolve({ total, favorites, byStatus }); return; }
      total += 1;
      const value = cursor.value;
      byStatus[value.status] = (byStatus[value.status] || 0) + 1;
      if (value.isFavorite === true) favorites += 1;
      cursor.continue();
    };
    cursorReq.onerror = () => reject(cursorReq.error || new Error('stats cursor failed'));
  });

  const storageSizes = {};
  for (const key of ['settings', 'emby_library_state', 'drive115_library_state']) {
    const value = await new Promise((resolve, reject) => {
      chrome.storage.local.get(key, (items) => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(`storage get ${key}: ${err.message}`));
        else resolve(items[key]);
      });
    });
    storageSizes[key] = value === undefined ? 0 : JSON.stringify(value).length;
  }

  const after = {
    viewed: stats.total,
    newWorks: await countStore('newWorks'),
    actors: await countStore('actors'),
    favorites: stats.favorites,
    byStatus: stats.byStatus,
    storage: storageSizes,
  };
  db.close();
  return { alreadySeeded, reset: doReset, before, after };
}
