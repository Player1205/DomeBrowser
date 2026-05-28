/**
 * ═══════════════════════════════════════════════════════════════
 *  tabGroups.js — Dome Browser  (V1: Contextual Tab Grouping)
 * ═══════════════════════════════════════════════════════════════
 *
 *  Responsibility:
 *    Full lifecycle management for tab groups.
 *    - Create, rename, delete, reorder groups
 *    - Color-coded group headers in the tab bar
 *    - Collapse/expand groups
 *    - Right-click context menu for group operations
 *    - Persistent storage in localStorage
 *
 *  Exposed globally as: window.DomeTabGroups
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

window.DomeTabGroups = (() => {

  // ─── Constants ──────────────────────────────────────────────────────────────

  const GROUP_COLORS = [
    { name: 'red',    label: 'Red'    },
    { name: 'orange', label: 'Orange' },
    { name: 'yellow', label: 'Yellow' },
    { name: 'green',  label: 'Green'  },
    { name: 'cyan',   label: 'Cyan'   },
    { name: 'blue',   label: 'Blue'   },
    { name: 'violet', label: 'Violet' },
    { name: 'pink',   label: 'Pink'   },
  ];

  const STORAGE_KEY = 'dome-tab-groups';

  // ─── Private State ──────────────────────────────────────────────────────────

  /** @type {Map<string, TabGroup>} */
  const _groups = new Map();

  let _groupCounter = 0;
  let _contextMenuEl = null;

  // ─── TabGroup Factory ───────────────────────────────────────────────────────

  /**
   * @typedef {object} TabGroup
   * @property {string}   id
   * @property {string}   name
   * @property {string}   color     — one of GROUP_COLORS[].name
   * @property {boolean}  collapsed
   * @property {string[]} tabIds    — ordered list of tab IDs in this group
   */
  function _createGroup({ name, color = 'blue' }) {
    _groupCounter++;
    return {
      id:        `group-${_groupCounter}-${Date.now()}`,
      name:      name || `Group ${_groupCounter}`,
      color:     color,
      collapsed: false,
      tabIds:    [],
    };
  }

  // ─── Persistence ────────────────────────────────────────────────────────────

  function _save() {
    try {
      const data = [..._groups.values()].map(g => ({
        id: g.id, name: g.name, color: g.color,
        collapsed: g.collapsed, tabIds: g.tabIds,
      }));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (_) { /* quota exceeded — non-fatal */ }
  }

  function _load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (!Array.isArray(data)) return;
      data.forEach(g => {
        if (g.id && g.name) {
          _groups.set(g.id, {
            id: g.id, name: g.name,
            color: g.color || 'blue',
            collapsed: g.collapsed || false,
            tabIds: Array.isArray(g.tabIds) ? g.tabIds : [],
          });
          const idNum = parseInt((g.id.match(/group-(\d+)/) || [])[1] || '0');
          if (idNum > _groupCounter) _groupCounter = idNum;
        }
      });
    } catch (_) { /* corrupt data — ignore */ }
  }

  // ─── Context Menu ───────────────────────────────────────────────────────────

  function _buildContextMenu() {
    const menu = document.createElement('div');
    menu.className = 'tab-context-menu';
    menu.id = 'tab-context-menu';
    document.body.appendChild(menu);

    // Close on outside click
    document.addEventListener('click', (e) => {
      if (!menu.contains(e.target)) {
        menu.classList.remove('visible');
      }
    });

    document.addEventListener('contextmenu', (e) => {
      if (!menu.contains(e.target) && !e.target.closest('.tab')) {
        menu.classList.remove('visible');
      }
    });

    return menu;
  }

  /**
   * Shows context menu for a tab.
   * @param {string} tabId
   * @param {number} x
   * @param {number} y
   */
  function showContextMenu(tabId, x, y) {
    if (!_contextMenuEl) return;

    const currentGroupId = getGroupForTab(tabId);
    const currentGroup = currentGroupId ? _groups.get(currentGroupId) : null;

    let html = '';

    // ── Add to new group ──
    html += `<button class="ctx-item" data-action="new-group" data-tab-id="${tabId}">
      <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.4">
        <line x1="6" y1="1" x2="6" y2="11"/><line x1="1" y1="6" x2="11" y2="6"/>
      </svg>
      New Group
    </button>`;

    // ── Add to existing group ──
    if (_groups.size > 0) {
      html += `<div class="ctx-submenu">
        <button class="ctx-item">
          <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.4">
            <rect x="1" y="3" width="10" height="7" rx="1"/><path d="M1 5h10"/>
          </svg>
          Add to Group
          <span style="margin-left:auto;opacity:0.5">▸</span>
        </button>
        <div class="ctx-submenu-panel">`;

      _groups.forEach((group) => {
        if (group.id !== currentGroupId) {
          html += `<button class="ctx-item" data-action="add-to-group" data-tab-id="${tabId}" data-group-id="${group.id}">
            <span class="ctx-color-dot" style="background:var(--group-color);"></span>
            ${_escapeHtml(group.name)}
          </button>`;
          // Fix: inline the color since CSS var won't resolve here
          html = html.replace(
            'style="background:var(--group-color);"',
            `style="background:${_getColorValue(group.color)};"`
          );
        }
      });

      html += `</div></div>`;
    }

    // ── Remove from group ──
    if (currentGroup) {
      html += `<div class="ctx-separator"></div>`;
      html += `<button class="ctx-item" data-action="remove-from-group" data-tab-id="${tabId}">
        Remove from Group
      </button>`;
      html += `<button class="ctx-item" data-action="rename-group" data-group-id="${currentGroupId}">
        Rename Group "${_escapeHtml(currentGroup.name)}"
      </button>`;

      // ── Change color submenu ──
      html += `<div class="ctx-submenu">
        <button class="ctx-item">
          Change Color
          <span style="margin-left:auto;opacity:0.5">▸</span>
        </button>
        <div class="ctx-submenu-panel">`;
      GROUP_COLORS.forEach(c => {
        html += `<button class="ctx-item" data-action="change-color" data-group-id="${currentGroupId}" data-color="${c.name}">
          <span class="ctx-color-dot" style="background:${_getColorValue(c.name)};"></span>
          ${c.label}
        </button>`;
      });
      html += `</div></div>`;

      html += `<button class="ctx-item" data-action="delete-group" data-group-id="${currentGroupId}" style="color:var(--red);">
        Delete Group
      </button>`;
    }

    // ── Separator + tab actions ──
    html += `<div class="ctx-separator"></div>`;
    html += `<button class="ctx-item" data-action="close-tab" data-tab-id="${tabId}">
      Close Tab
    </button>`;
    html += `<button class="ctx-item" data-action="close-other-tabs" data-tab-id="${tabId}">
      Close Other Tabs
    </button>`;

    _contextMenuEl.innerHTML = html;

    // Position
    const menuWidth = 180;
    const menuHeight = _contextMenuEl.scrollHeight || 200;
    const maxX = window.innerWidth - menuWidth - 8;
    const maxY = window.innerHeight - menuHeight - 8;
    _contextMenuEl.style.left = `${Math.min(x, maxX)}px`;
    _contextMenuEl.style.top  = `${Math.min(y, maxY)}px`;
    _contextMenuEl.classList.add('visible');

    // Bind actions
    _contextMenuEl.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', _handleContextAction, { once: true });
    });
  }

  function _handleContextAction(e) {
    const btn = e.currentTarget;
    const action  = btn.dataset.action;
    const tabId   = btn.dataset.tabId;
    const groupId = btn.dataset.groupId;
    const color   = btn.dataset.color;

    _contextMenuEl.classList.remove('visible');

    switch (action) {
      case 'new-group': {
        const group = createGroup({ name: '', color: _nextColor() });
        addTabToGroup(tabId, group.id);
        // Prompt rename
        requestAnimationFrame(() => {
          const header = document.querySelector(`.tab-group[data-group-id="${group.id}"] .tab-group-label`);
          if (header) _startRename(group.id, header);
        });
        break;
      }
      case 'add-to-group':
        addTabToGroup(tabId, groupId);
        break;
      case 'remove-from-group':
        removeTabFromGroup(tabId);
        break;
      case 'rename-group': {
        const header = document.querySelector(`.tab-group[data-group-id="${groupId}"] .tab-group-label`);
        if (header) _startRename(groupId, header);
        break;
      }
      case 'change-color':
        changeGroupColor(groupId, color);
        break;
      case 'delete-group':
        deleteGroup(groupId);
        break;
      case 'close-tab':
        DomeTabs?.closeTab(tabId);
        break;
      case 'close-other-tabs': {
        const allTabs = DomeTabs?.getAllTabs();
        if (allTabs) {
          [...allTabs.keys()].filter(id => id !== tabId).forEach(id => DomeTabs.closeTab(id));
        }
        break;
      }
    }
  }

  function _startRename(groupId, labelEl) {
    const group = _groups.get(groupId);
    if (!group) return;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'ctx-group-name';
    input.value = group.name;
    input.style.width = '80px';

    const parent = labelEl.parentNode;
    parent.replaceChild(input, labelEl);
    input.focus();
    input.select();

    const finish = () => {
      const newName = input.value.trim() || `Group ${groupId.match(/\d+/)?.[0] || ''}`;
      group.name = newName;
      _save();
      _renderGroups();
    };

    input.addEventListener('blur', finish, { once: true });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') { input.value = group.name; input.blur(); }
    });
  }

  // ─── Color Helpers ──────────────────────────────────────────────────────────

  let _colorIndex = 0;
  function _nextColor() {
    const color = GROUP_COLORS[_colorIndex % GROUP_COLORS.length].name;
    _colorIndex++;
    return color;
  }

  function _getColorValue(colorName) {
    const map = {
      red: '#C83030', orange: '#C86020', yellow: '#A08010', green: '#308830',
      cyan: '#1888A0', blue: '#3060C0', violet: '#7050C8', pink: '#C03888',
    };
    return map[colorName] || map.blue;
  }

  // ─── Rendering ──────────────────────────────────────────────────────────────

  /**
   * Re-renders the tab bar with groups.
   * Called after any group mutation.
   */
  function _renderGroups() {
    const tabListEl = document.getElementById('tab-list');
    if (!tabListEl) return;

    const allTabs = DomeTabs?.getAllTabs();
    if (!allTabs) return;

    // Collect all grouped tab IDs
    const groupedTabIds = new Set();
    _groups.forEach(g => g.tabIds.forEach(id => groupedTabIds.add(id)));

    // Clean up stale tab references
    _groups.forEach(g => {
      g.tabIds = g.tabIds.filter(id => allTabs.has(id));
    });

    // Remove empty groups
    _groups.forEach((g, id) => {
      if (g.tabIds.length === 0) _groups.delete(id);
    });

    // Clear tab list
    tabListEl.innerHTML = '';

    // Render grouped tabs
    _groups.forEach((group) => {
      const groupEl = document.createElement('div');
      groupEl.className = `tab-group${group.collapsed ? ' collapsed' : ''}`;
      groupEl.dataset.groupId = group.id;
      groupEl.dataset.color = group.color;

      // Group header
      const header = document.createElement('div');
      header.className = 'tab-group-header';
      header.innerHTML = `
        <span class="tab-group-collapse-icon">
          <svg viewBox="0 0 8 8" width="8" height="8" fill="none" stroke="currentColor" stroke-width="1.5">
            <polyline points="2,1 6,4 2,7"/>
          </svg>
        </span>
        <span class="tab-group-label">${_escapeHtml(group.name)}</span>
        <span class="tab-group-count">${group.tabIds.length}</span>
      `;

      header.addEventListener('click', () => {
        group.collapsed = !group.collapsed;
        groupEl.classList.toggle('collapsed', group.collapsed);
        _save();
      });

      // Double-click to rename
      header.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        const labelEl = header.querySelector('.tab-group-label');
        if (labelEl) _startRename(group.id, labelEl);
      });

      groupEl.appendChild(header);

      // Append tabs in group order
      group.tabIds.forEach(tabId => {
        const tab = allTabs.get(tabId);
        if (tab?.tabEl) {
          groupEl.appendChild(tab.tabEl);
        }
      });

      // Divider after group
      const divider = document.createElement('div');
      divider.className = 'tab-group-divider';
      groupEl.appendChild(divider);

      tabListEl.appendChild(groupEl);
    });

    // Render ungrouped tabs
    allTabs.forEach((tab, tabId) => {
      if (!groupedTabIds.has(tabId) && tab.tabEl) {
        tabListEl.appendChild(tab.tabEl);
      }
    });

    _save();
  }

  // ─── Utility ────────────────────────────────────────────────────────────────

  function _escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str || '';
    return d.innerHTML;
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  function init() {
    _contextMenuEl = _buildContextMenu();
    _load();
  }

  /**
   * Creates a new tab group.
   * @param {object} opts
   * @param {string} [opts.name]
   * @param {string} [opts.color]
   * @returns {TabGroup}
   */
  function createGroup({ name = '', color } = {}) {
    const group = _createGroup({ name, color: color || _nextColor() });
    _groups.set(group.id, group);
    _save();
    return group;
  }

  /**
   * Adds a tab to a group. Removes it from any existing group first.
   */
  function addTabToGroup(tabId, groupId) {
    // Remove from current group if any
    _groups.forEach(g => {
      g.tabIds = g.tabIds.filter(id => id !== tabId);
    });

    const group = _groups.get(groupId);
    if (group) {
      group.tabIds.push(tabId);
      _renderGroups();
    }
  }

  /**
   * Removes a tab from its group.
   */
  function removeTabFromGroup(tabId) {
    _groups.forEach(g => {
      g.tabIds = g.tabIds.filter(id => id !== tabId);
    });
    _renderGroups();
  }

  /**
   * Gets the group ID for a tab, or null if ungrouped.
   */
  function getGroupForTab(tabId) {
    for (const [groupId, group] of _groups) {
      if (group.tabIds.includes(tabId)) return groupId;
    }
    return null;
  }

  /**
   * Changes a group's color.
   */
  function changeGroupColor(groupId, color) {
    const group = _groups.get(groupId);
    if (group) {
      group.color = color;
      _save();
      _renderGroups();
    }
  }

  /**
   * Deletes a group. Tabs become ungrouped.
   */
  function deleteGroup(groupId) {
    _groups.delete(groupId);
    _renderGroups();
  }

  /**
   * Called by DomeTabs when a tab is closed.
   */
  function onTabClosed(tabId) {
    _groups.forEach(g => {
      g.tabIds = g.tabIds.filter(id => id !== tabId);
    });
    // Clean up empty groups
    _groups.forEach((g, id) => {
      if (g.tabIds.length === 0) _groups.delete(id);
    });
    _save();
  }

  /**
   * Re-renders group UI. Called by DomeTabs after tab creation/close.
   */
  function renderGroups() {
    _renderGroups();
  }

  /**
   * Gets all groups.
   */
  function getAllGroups() {
    return _groups;
  }

  return {
    init,
    createGroup,
    addTabToGroup,
    removeTabFromGroup,
    getGroupForTab,
    changeGroupColor,
    deleteGroup,
    onTabClosed,
    renderGroups,
    showContextMenu,
    getAllGroups,
    GROUP_COLORS,
  };

})();
