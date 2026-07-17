/* nav-app.js - Wnav 前端交互逻辑 */
(function() {
  'use strict';

  const API_BASE = './api';
  let isAdmin = false;
  let apiKey = localStorage.getItem('wnav_api_key') || '';
  let categoriesData = [];
  let settingsData = {};

  /* ---------- 工具函数 ---------- */
  function $(sel) { return document.querySelector(sel); }
  function $$(sel) { return document.querySelectorAll(sel); }
  function el(tag, attrs, children) {
    const e = document.createElement(tag);
    if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (children) children.forEach(c => e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
    return e;
  }

  async function api(path, opts) {
    const url = API_BASE + '/' + path;
    const options = opts || {};
    options.headers = options.headers || {};
    if (apiKey) options.headers['X-API-Key'] = apiKey;
    options.headers['Content-Type'] = 'application/json';
    const res = await fetch(url, options);
    return res.json().catch(() => ({}));
  }

  function toast(msg, type) {
    const t = el('div', { class: 'nav-toast nav-toast-' + (type || 'info') }, [msg]);
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3000);
  }

  /* ---------- 登录 ---------- */
  function showLogin() {
    const modal = el('div', { class: 'nav-modal', id: 'nav-login-modal' }, [
      el('div', { class: 'nav-modal-content' }, [
        el('div', { class: 'nav-modal-header' }, [
          el('h3', {}, ['管理员登录']),
          el('button', { class: 'nav-modal-close', onclick: 'this.closest(".nav-modal").remove()' }, ['×'])
        ]),
        el('div', { class: 'nav-modal-body' }, [
          el('input', { id: 'nav-login-user', type: 'text', placeholder: '账号（如需要）', style: 'display:none' }),
          el('input', { id: 'nav-login-pwd', type: 'password', placeholder: '管理密码' }),
          el('button', { class: 'nav-btn nav-btn-primary', onclick: 'window.navApp.doLogin()' }, ['登录'])
        ])
      ])
    ]);
    document.body.appendChild(modal);
    $('#nav-login-user').style.display = settingsData.needUsername ? 'block' : 'none';
  }

  async function doLogin() {
    const username = $('#nav-login-user').value.trim();
    const password = $('#nav-login-pwd').value;
    const body = { password };
    if (settingsData.needUsername) body.username = username;
    const res = await api('login', { method: 'POST', body: JSON.stringify(body) });
    if (res.ok) {
      apiKey = res.token;
      localStorage.setItem('wnav_api_key', apiKey);
      localStorage.setItem('wnav_api_expires', res.expiresAt);
      isAdmin = true;
      $('#nav-login-modal').remove();
      toast('登录成功', 'success');
      updateUI();
      loadData();
    } else {
      toast(res.error || '登录失败', 'error');
    }
  }

  function logout() {
    apiKey = '';
    localStorage.removeItem('wnav_api_key');
    localStorage.removeItem('wnav_api_expires');
    isAdmin = false;
    toast('已退出登录', 'info');
    updateUI();
    loadData();
  }

  function checkToken() {
    const exp = localStorage.getItem('wnav_api_expires');
    if (exp && Date.now() > parseInt(exp, 10)) {
      logout();
      return false;
    }
    return !!apiKey;
  }

  /* ---------- 数据加载 ---------- */
  async function loadData() {
    const res = await api('data', { method: 'GET' });
    if (res.categories) {
      categoriesData = res.categories;
      isAdmin = res.admin;
      settingsData = res.settings || {};
      renderCategories();
      updateUI();
    }
  }

  /* ---------- 渲染分类和书签 ---------- */
  function renderCategories() {
    const container = $('.sidebar-menu');
    if (!container) return;
    container.innerHTML = '';
    categoriesData.forEach(cat => {
      const li = el('li', { class: 'sidebar-item' }, [
        el('a', { href: '#cat-' + cat.id, class: 'smooth' }, [cat.name])
      ]);
      container.appendChild(li);
    });
  }

  /* ---------- 添加书签 ---------- */
  function showAddBookmark() {
    if (!isAdmin) { showLogin(); return; }
    const modal = el('div', { class: 'nav-modal', id: 'nav-add-modal' }, [
      el('div', { class: 'nav-modal-content' }, [
        el('div', { class: 'nav-modal-header' }, [
          el('h3', {}, ['添加书签']),
          el('button', { class: 'nav-modal-close', onclick: 'this.closest(".nav-modal").remove()' }, ['×'])
        ]),
        el('div', { class: 'nav-modal-body' }, [
          el('input', { id: 'bm-title', placeholder: '名称 *' }),
          el('input', { id: 'bm-url', placeholder: '链接 URL *' }),
          el('input', { id: 'bm-backup', placeholder: '备用链接' }),
          el('input', { id: 'bm-icon', placeholder: '图标 URL（留空自动获取）' }),
          el('input', { id: 'bm-keywords', placeholder: '关键词' }),
          el('textarea', { id: 'bm-desc', placeholder: '描述' }),
          el('select', { id: 'bm-cat' }, [el('option', { value: '' }, ['选择分类...'])]),
          el('label', {}, [
            el('input', { id: 'bm-private', type: 'checkbox' }),
            ' 私有书签（仅管理员可见）'
          ]),
          el('div', { class: 'nav-modal-actions' }, [
            el('button', { class: 'nav-btn', onclick: 'window.navApp.fetchTitle()' }, ['🔍 识别标题']),
            el('button', { class: 'nav-btn', onclick: 'window.navApp.fetchIcon()' }, ['🖼️ 获取图标']),
            el('button', { class: 'nav-btn nav-btn-primary', onclick: 'window.navApp.doAddBookmark()' }, ['添加'])
          ])
        ])
      ])
    ]);
    document.body.appendChild(modal);
    const sel = $('#bm-cat');
    categoriesData.forEach(c => {
      sel.appendChild(el('option', { value: c.id }, [c.name]));
    });
  }

  async function doAddBookmark() {
    const bookmark = {
      title: $('#bm-title').value.trim(),
      url: $('#bm-url').value.trim(),
      backupUrl: $('#bm-backup').value.trim(),
      icon: $('#bm-icon').value.trim(),
      keywords: $('#bm-keywords').value.trim(),
      description: $('#bm-desc').value.trim(),
      private: $('#bm-private').checked,
    };
    const catId = $('#bm-cat').value;
    if (!catId) { toast('请选择分类', 'error'); return; }
    const res = await api('bookmarks', {
      method: 'POST',
      body: JSON.stringify({ bookmark, categoryId: catId })
    });
    if (res.ok) {
      toast('添加成功', 'success');
      $('#nav-add-modal').remove();
      loadData();
    } else {
      toast(res.error || '添加失败', 'error');
    }
  }

  /* ---------- 编辑/删除书签 ---------- */
  function showEditBookmark(id) {
    if (!isAdmin) { showLogin(); return; }
    // Find bookmark
    let bm = null, catId = '';
    for (const c of categoriesData) {
      const found = (c.links || []).find(l => l.id === id);
      if (found) { bm = found; catId = c.id; break; }
      for (const g of (c.groups || [])) {
        const found2 = (g.links || []).find(l => l.id === id);
        if (found2) { bm = found2; catId = c.id; break; }
      }
      if (bm) break;
    }
    if (!bm) { toast('书签不存在', 'error'); return; }

    const modal = el('div', { class: 'nav-modal', id: 'nav-edit-modal' }, [
      el('div', { class: 'nav-modal-content' }, [
        el('div', { class: 'nav-modal-header' }, [
          el('h3', {}, ['编辑书签']),
          el('button', { class: 'nav-modal-close', onclick: 'this.closest(".nav-modal").remove()' }, ['×'])
        ]),
        el('div', { class: 'nav-modal-body' }, [
          el('input', { id: 'ebm-title', value: bm.title, placeholder: '名称 *' }),
          el('input', { id: 'ebm-url', value: bm.url, placeholder: '链接 URL *' }),
          el('input', { id: 'ebm-backup', value: bm.backupUrl || '', placeholder: '备用链接' }),
          el('input', { id: 'ebm-icon', value: bm.icon || '', placeholder: '图标 URL' }),
          el('input', { id: 'ebm-keywords', value: bm.keywords || '', placeholder: '关键词' }),
          el('textarea', { id: 'ebm-desc', placeholder: '描述' }, [bm.description || '']),
          el('label', {}, [
            el('input', { id: 'ebm-private', type: 'checkbox', checked: bm.private }),
            ' 私有书签'
          ]),
          el('div', { class: 'nav-modal-actions' }, [
            el('button', { class: 'nav-btn nav-btn-danger', onclick: 'window.navApp.doDeleteBookmark("' + id + '")' }, ['删除']),
            el('button', { class: 'nav-btn nav-btn-primary', onclick: 'window.navApp.doUpdateBookmark("' + id + '")' }, ['保存'])
          ])
        ])
      ])
    ]);
    document.body.appendChild(modal);
  }

  async function doUpdateBookmark(id) {
    const bookmark = {
      title: $('#ebm-title').value.trim(),
      url: $('#ebm-url').value.trim(),
      backupUrl: $('#ebm-backup').value.trim(),
      icon: $('#ebm-icon').value.trim(),
      keywords: $('#ebm-keywords').value.trim(),
      description: $('#ebm-desc').value.trim(),
      private: $('#ebm-private').checked,
    };
    const res = await api('bookmarks/' + id, {
      method: 'PUT',
      body: JSON.stringify({ bookmark })
    });
    if (res.ok) {
      toast('更新成功', 'success');
      $('#nav-edit-modal').remove();
      loadData();
    } else {
      toast(res.error || '更新失败', 'error');
    }
  }

  async function doDeleteBookmark(id) {
    if (!confirm('确定删除此书签？')) return;
    const res = await api('bookmarks/' + id, { method: 'DELETE' });
    if (res.ok) {
      toast('已删除', 'success');
      $('#nav-edit-modal').remove();
      loadData();
    } else {
      toast(res.error || '删除失败', 'error');
    }
  }

  /* ---------- 获取标题/图标 ---------- */
  async function fetchTitle() {
    const url = $('#bm-url').value.trim();
    if (!url) { toast('先填写链接', 'error'); return; }
    toast('正在识别...', 'info');
    const res = await api('title?url=' + encodeURIComponent(url), { method: 'GET' });
    if (res.title) {
      $('#bm-title').value = res.title;
      toast('识别成功', 'success');
    } else {
      toast(res.error || '识别失败', 'error');
    }
  }

  async function fetchIcon() {
    const url = $('#bm-url').value.trim();
    if (!url) { toast('先填写链接', 'error'); return; }
    toast('正在获取图标...', 'info');
    const res = await api('icon?url=' + encodeURIComponent(url), { method: 'GET' });
    if (res.ok && res.iconUrl) {
      $('#bm-icon').value = res.iconUrl;
      toast('获取成功', 'success');
    } else {
      toast(res.error || '获取失败', 'error');
    }
  }

  /* ---------- 设置 ---------- */
  function showSettings() {
    if (!isAdmin) { showLogin(); return; }
    api('settings', { method: 'GET' }).then(res => {
      const s = res.settings || {};
      const modal = el('div', { class: 'nav-modal', id: 'nav-settings-modal' }, [
        el('div', { class: 'nav-modal-content' }, [
          el('div', { class: 'nav-modal-header' }, [
            el('h3', {}, ['站点设置']),
            el('button', { class: 'nav-modal-close', onclick: 'this.closest(".nav-modal").remove()' }, ['×'])
          ]),
          el('div', { class: 'nav-modal-body' }, [
            el('label', {}, ['站点标题']),
            el('input', { id: 'set-title', value: s.siteTitle || '', placeholder: '留空使用默认' }),
            el('label', {}, ['和风天气 Key']),
            el('input', { id: 'set-weather-key', value: s.qweatherKey || '', placeholder: '和风天气 API Key' }),
            el('label', {}, ['和风天气城市']),
            el('input', { id: 'set-weather-city', value: s.qweatherCity || '', placeholder: '如：北京' }),
            el('label', {}, ['和风 API 域名（可选）']),
            el('input', { id: 'set-weather-host', value: s.qweatherHost || '', placeholder: '如 xxx.re.qweatherapi.com' }),
            el('div', { class: 'nav-modal-actions' }, [
              el('button', { class: 'nav-btn nav-btn-primary', onclick: 'window.navApp.doSaveSettings()' }, ['保存'])
            ])
          ])
        ])
      ]);
      document.body.appendChild(modal);
    });
  }

  async function doSaveSettings() {
    const settings = {
      siteTitle: $('#set-title').value.trim(),
      qweatherKey: $('#set-weather-key').value.trim(),
      qweatherCity: $('#set-weather-city').value.trim(),
      qweatherHost: $('#set-weather-host').value.trim(),
    };
    const res = await api('settings', {
      method: 'PUT',
      body: JSON.stringify({ settings })
    });
    if (res.ok) {
      toast('保存成功', 'success');
      $('#nav-settings-modal').remove();
      loadData();
    } else {
      toast(res.error || '保存失败', 'error');
    }
  }

  /* ---------- 天气 ---------- */
  async function loadWeather() {
    const city = settingsData.qweatherCity || '北京';
    const res = await api('weather?city=' + encodeURIComponent(city), { method: 'GET' });
    const el = $('#nav-weather');
    if (el && res.temp !== undefined) {
      el.textContent = city + ' ' + res.temp + '°C ' + (res.text || '');
    }
  }

  /* ---------- 右键菜单 ---------- */
  function showContextMenu(e, bookmarkId) {
    e.preventDefault();
    const existing = $('#nav-context-menu');
    if (existing) existing.remove();

    const menu = el('div', {
      class: 'nav-context-menu',
      id: 'nav-context-menu',
      style: 'position:fixed;left:' + e.clientX + 'px;top:' + e.clientY + 'px;z-index:9999;'
    }, [
      el('div', { class: 'nav-context-item', onclick: 'window.navApp.visitBookmark("' + bookmarkId + '")' }, ['访问']),
      el('div', { class: 'nav-context-item', onclick: 'window.navApp.copyBookmark("' + bookmarkId + '")' }, ['复制链接']),
      isAdmin ? el('div', { class: 'nav-context-item', onclick: 'window.navApp.showEditBookmark("' + bookmarkId + '")' }, ['编辑']) : null,
      isAdmin ? el('div', { class: 'nav-context-item nav-context-danger', onclick: 'window.navApp.doDeleteBookmark("' + bookmarkId + '")' }, ['删除']) : null,
    ].filter(Boolean));
    document.body.appendChild(menu);
  }

  function visitBookmark(id) {
    $('#nav-context-menu')?.remove();
    for (const c of categoriesData) {
      for (const l of (c.links || [])) if (l.id === id) { window.open(l.url, '_blank'); return; }
      for (const g of (c.groups || [])) {
        for (const l of (g.links || [])) if (l.id === id) { window.open(l.url, '_blank'); return; }
      }
    }
  }

  function copyBookmark(id) {
    $('#nav-context-menu')?.remove();
    for (const c of categoriesData) {
      for (const l of (c.links || [])) if (l.id === id) { navigator.clipboard.writeText(l.url); toast('已复制', 'success'); return; }
      for (const g of (c.groups || [])) {
        for (const l of (g.links || [])) if (l.id === id) { navigator.clipboard.writeText(l.url); toast('已复制', 'success'); return; }
      }
    }
  }

  /* ---------- UI 更新 ---------- */
  function updateUI() {
    const loginBtn = $('#nav-login-btn');
    const addBtn = $('#nav-add-btn');
    const settingsBtn = $('#nav-settings-btn');
    if (loginBtn) loginBtn.innerHTML = isAdmin ? '✓' : '🔒';
    if (loginBtn) loginBtn.title = isAdmin ? '已登录（点击退出）' : '管理员登录';
    if (loginBtn) loginBtn.onclick = isAdmin ? logout : showLogin;
    if (addBtn) addBtn.onclick = showAddBookmark;
    if (settingsBtn) settingsBtn.onclick = showSettings;
  }

  /* ---------- 初始化 ---------- */
  function init() {
    checkToken();
    loadData();
    loadWeather();

    // 点击空白处关闭右键菜单
    document.addEventListener('click', () => {
      const m = $('#nav-context-menu');
      if (m) m.remove();
    });

    // 绑定书签卡片的右键事件（通过事件委托）
    document.addEventListener('contextmenu', (e) => {
      const card = e.target.closest('[data-bookmark-id]');
      if (card) showContextMenu(e, card.dataset.bookmarkId);
    });
  }

  /* ---------- 暴露全局 ---------- */
  window.navApp = {
    init, showLogin, doLogin, logout,
    showAddBookmark, doAddBookmark,
    showEditBookmark, doUpdateBookmark, doDeleteBookmark,
    fetchTitle, fetchIcon,
    showSettings, doSaveSettings,
    visitBookmark, copyBookmark,
    loadData, loadWeather
  };

  // 页面加载完成后初始化
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
