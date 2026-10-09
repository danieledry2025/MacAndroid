'use strict';

// Inline SVG icons. UI icons use currentColor; file icons carry their own colours.
const ui = (d, extra = '') =>
  `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ${extra}>${d}</svg>`;

const ICONS = {
  back: ui('<path d="M9 6l6 6-6 6"/>'), // RTL: "back" points right
  forward: ui('<path d="M15 6l-6 6 6 6"/>'),
  up: ui('<path d="M12 19V5M6 11l6-6 6 6"/>'),
  grid: ui('<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>'),
  list: ui('<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>'),
  close: ui('<path d="M6 6l12 12M18 6L6 18"/>'),
  download: ui('<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>'),
  upload: ui('<path d="M12 20V9M7 14l5-5 5 5M5 4h14"/>'),
  folderPlus: ui('<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><path d="M12 10v6M9 13h6"/>'),
  trash: ui('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>'),
  copy: ui('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2"/>'),
  paste: ui('<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3h6v1M9 11h6M9 15h4"/>'),
  refresh: ui('<path d="M20 11a8 8 0 10-2.3 5.7M20 4v7h-7"/>'),
  play: '<svg viewBox="0 0 24 24" width="28" height="28"><circle cx="12" cy="12" r="11" fill="rgba(0,0,0,.55)"/><path d="M10 8l6 4-6 4z" fill="#fff"/></svg>',
  chevronPrev: ui('<path d="M9 5l7 7-7 7"/>', 'width="32" height="32"'),
  chevronNext: ui('<path d="M15 5l-7 7 7 7"/>', 'width="32" height="32"'),
  phone: ui('<rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M11 18.5h2"/>'),
  sd: ui('<path d="M8 3h8l3 3v13a2 2 0 01-2 2H7a2 2 0 01-2-2V6z"/><path d="M9 7v3M12 7v3M15 7v3"/>'),
  desktop: ui('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>'),
  doc: ui('<path d="M7 3h7l5 5v11a2 2 0 01-2 2H7a2 2 0 01-2-2V5a2 2 0 012-2z"/><path d="M14 3v5h5"/>'),
  image: ui('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 17l-5-5-9 8"/>'),
  video: ui('<rect x="3" y="5" width="13" height="14" rx="2"/><path d="M16 10l5-3v10l-5-3"/>'),
  home: ui('<path d="M4 11l8-7 8 7v9a1 1 0 01-1 1h-4v-6H9v6H5a1 1 0 01-1-1z"/>'),
  usb: ui('<path d="M12 3v14M9 6l3-3 3 3M8 11v2l4 3M16 9v3l-4 3"/><circle cx="12" cy="19" r="2"/>'),
  split: ui('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/>'),
  sortDown: ui('<path d="M8 4v16M4 16l4 4 4-4M14 6h7M14 11h5M14 16h3"/>'),
  sortUp: ui('<path d="M8 20V4M4 8l4-4 4 4M14 6h3M14 11h5M14 16h7"/>'),
  swap: ui('<path d="M4 8h16M16 4l4 4-4 4M20 16H4M8 12l-4 4 4 4"/>'),
  folderSmall: ui('<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>'),
};

const FOLDER_SVG = `<svg viewBox="0 0 64 64" class="ficon">
  <path d="M6 14a4 4 0 014-4h14l5 5h25a4 4 0 014 4v4H6z" fill="#e8a91b"/>
  <rect x="6" y="19" width="52" height="36" rx="4" fill="#ffc83d"/>
  <rect x="6" y="19" width="52" height="5" fill="#ffd968" opacity=".7"/>
</svg>`;

const FILE_COLORS = {
  image: '#2e9e5b',
  video: '#d6453d',
  audio: '#8a4fd8',
  pdf: '#d93025',
  doc: '#2f6fdf',
  archive: '#8c6d3a',
  apk: '#3ddc84',
  file: '#7b8794',
};

function fileSvg(kind, ext) {
  const c = FILE_COLORS[kind] || FILE_COLORS.file;
  const label = (ext || '').slice(0, 4).toUpperCase();
  return `<svg viewBox="0 0 64 64" class="ficon">
    <path d="M14 4h26l12 12v42a3 3 0 01-3 3H14a3 3 0 01-3-3V7a3 3 0 013-3z" fill="#fff" stroke="#c9ced6" stroke-width="1.5"/>
    <path d="M40 4v9a3 3 0 003 3h9" fill="#eef1f5" stroke="#c9ced6" stroke-width="1.5"/>
    ${label ? `<rect x="8" y="36" width="40" height="15" rx="3" fill="${c}"/><text x="28" y="47.5" text-anchor="middle" font-size="10" font-weight="700" font-family="-apple-system,Helvetica,Arial" fill="#fff">${label}</text>` : ''}
  </svg>`;
}

const DRIVE_SVG = (type) => `<svg viewBox="0 0 64 64" class="ficon">
  ${
    type === 'sd'
      ? '<path d="M18 6h22l10 10v38a4 4 0 01-4 4H18a4 4 0 01-4-4V10a4 4 0 014-4z" fill="#4a5568"/><path d="M22 10v10M28 10v10M34 10v10M40 12v8" stroke="#f6c343" stroke-width="3"/><rect x="20" y="34" width="24" height="12" rx="2" fill="#718096"/>'
      : '<rect x="18" y="4" width="28" height="56" rx="6" fill="#2d3748"/><rect x="21" y="9" width="22" height="42" rx="2" fill="#63b3ed"/><rect x="28" y="54" width="8" height="2" rx="1" fill="#a0aec0"/>'
  }
</svg>`;

window.ICONS = ICONS;
window.FOLDER_SVG = FOLDER_SVG;
window.fileSvg = fileSvg;
window.DRIVE_SVG = DRIVE_SVG;
