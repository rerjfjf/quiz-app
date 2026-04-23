const fs = require('fs');
const path = require('path');

const root = '/Users/nikitasokovyh/quiz-app/pddtest_work';
const signsDir = path.join(root, 'signs');

const TITLES = {
  '1.5.png': 'Трамвай',
  '1.9.png': 'Разводной мост',
  '1.10.png': 'Набережная',
  '1.33.png': 'Прочая опасность',
  '2.1.png': 'Главная дорога',
  '2.3.1.png': 'Примыкание',
  '2.4.png': 'Уступите дорогу',
  '3.1.png': 'Въезд запрещен',
  '3.3.png': 'МТС запрещено',
  '3.4.png': 'Грузовым запрещено',
  '3.5.png': 'Мотоциклам запрещено',
  '3.6.png': 'Тракторам запрещено',
  '3.7.png': 'С прицепом запрещено',
  '3.9.png': 'Велосипедам запрещено',
  '3.10.png': 'Пешеходам запрещено',
  '3.11.png': 'Ограничение массы',
  '3.12.png': 'Нагрузка на ось',
  '3.13.png': 'Ограничение высоты',
  '3.18.png': 'Поворот запрещен',
  '3.20.png': 'Обгон запрещен',
  '3.22.png': 'Обгон грузовым запрещен',
  '3.24.png': 'Ограничение скорости',
  '3.27.png': 'Остановка запрещена',
  '3.28.png': 'Стоянка запрещена',
  '3.31.png': 'Конец ограничений',
  '3.32.png': 'Конец зоны',
  '4.1.png': 'Прямо',
  '4.2.png': 'Направо',
  '4.3.png': 'Налево',
  '4.5.png': 'Пешеходная дорожка',
  '4.6.png': 'Велодорожка',
  '4.7.png': 'Пешеходная дорожка',
  '4.8.png': 'Вело и пешеходы',
  '4.16.png': 'Мин. скорость',
  '4.17.png': 'Конец мин. скорости',
  '4.18.png': 'Мин. скорость',
  '5.1.png': 'Автомагистраль',
  '5.11.png': 'Дорога с полосой',
  '5.14.png': 'Полоса для автобусов',
  '5.15.png': 'Направления по полосам',
  '5.19.png': 'Переход',
  '5.25.png': 'Одностороннее движение',
  '5.27.png': 'Жилая зона',
  '5.29.png': 'Пешеходная зона',
  '5.33.png': 'Велосипедная зона',
  '6.2.png': 'Место отдыха',
  '6.4.png': 'Место стоянки',
  '6.5.png': 'Зона стоянки',
  '6.6.png': 'Конец зоны стоянки',
  '6.11.png': 'Телефон',
  '7.1.png': 'Медпомощь',
  '7.4.png': 'АЗС',
};

function getTheme(file) {
  const group = file.split('.')[0];
  if (group === '1') return { shape: 'triangle', bg: '#ffffff', border: '#d62828', accent: '#1f2937' };
  if (group === '2') return { shape: 'diamond', bg: '#ffe066', border: '#111827', accent: '#111827' };
  if (group === '3') return { shape: 'ring', bg: '#ffffff', border: '#d62828', accent: '#111827' };
  if (group === '4') return { shape: 'circle', bg: '#1677ff', border: '#0b4db3', accent: '#ffffff' };
  if (group === '5') return { shape: 'rect', bg: '#1677ff', border: '#0b4db3', accent: '#ffffff' };
  if (group === '6') return { shape: 'square', bg: '#1677ff', border: '#0b4db3', accent: '#ffffff' };
  return { shape: 'plate', bg: '#ffffff', border: '#94a3b8', accent: '#111827' };
}

function wrapText(text, max) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length > max && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 2);
}

function drawShape(theme, code) {
  if (theme.shape === 'triangle') {
    return `
      <polygon points="256,54 448,388 64,388" fill="${theme.bg}" stroke="${theme.border}" stroke-width="22"/>
      <text x="256" y="265" text-anchor="middle" font-size="70" font-family="Arial, sans-serif" font-weight="700" fill="${theme.accent}">${code}</text>
    `;
  }
  if (theme.shape === 'diamond') {
    return `
      <rect x="126" y="90" width="260" height="260" rx="20" transform="rotate(45 256 220)" fill="${theme.bg}" stroke="${theme.border}" stroke-width="18"/>
      <text x="256" y="246" text-anchor="middle" font-size="72" font-family="Arial, sans-serif" font-weight="700" fill="${theme.accent}">${code}</text>
    `;
  }
  if (theme.shape === 'ring') {
    return `
      <circle cx="256" cy="220" r="152" fill="${theme.bg}" stroke="${theme.border}" stroke-width="34"/>
      <circle cx="256" cy="220" r="102" fill="${theme.bg}"/>
      <text x="256" y="244" text-anchor="middle" font-size="72" font-family="Arial, sans-serif" font-weight="700" fill="${theme.accent}">${code}</text>
    `;
  }
  if (theme.shape === 'circle') {
    return `
      <circle cx="256" cy="220" r="152" fill="${theme.bg}" stroke="${theme.border}" stroke-width="12"/>
      <text x="256" y="246" text-anchor="middle" font-size="72" font-family="Arial, sans-serif" font-weight="700" fill="${theme.accent}">${code}</text>
    `;
  }
  if (theme.shape === 'rect') {
    return `
      <rect x="86" y="88" width="340" height="264" rx="28" fill="${theme.bg}" stroke="${theme.border}" stroke-width="12"/>
      <text x="256" y="246" text-anchor="middle" font-size="72" font-family="Arial, sans-serif" font-weight="700" fill="${theme.accent}">${code}</text>
    `;
  }
  if (theme.shape === 'square') {
    return `
      <rect x="108" y="72" width="296" height="296" rx="22" fill="${theme.bg}" stroke="${theme.border}" stroke-width="12"/>
      <text x="256" y="246" text-anchor="middle" font-size="72" font-family="Arial, sans-serif" font-weight="700" fill="${theme.accent}">${code}</text>
    `;
  }
  return `
    <rect x="76" y="96" width="360" height="240" rx="20" fill="${theme.bg}" stroke="${theme.border}" stroke-width="10"/>
    <text x="256" y="238" text-anchor="middle" font-size="72" font-family="Arial, sans-serif" font-weight="700" fill="${theme.accent}">${code}</text>
  `;
}

function makeSvg(file) {
  const theme = getTheme(file);
  const code = file.replace('.png', '');
  const title = TITLES[file] || code;
  const lines = wrapText(title, 18);
  const labelColor = theme.shape === 'circle' || theme.shape === 'rect' || theme.shape === 'square'
    ? 'rgba(255,255,255,0.95)'
    : '#0f172a';

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="32" fill="#f8fafc"/>
  <rect x="20" y="20" width="472" height="472" rx="28" fill="#e2e8f0"/>
  ${drawShape(theme, code)}
  <rect x="54" y="404" width="404" height="68" rx="18" fill="#ffffff" stroke="#cbd5e1" stroke-width="4"/>
  <text x="256" y="432" text-anchor="middle" font-size="25" font-family="Arial, sans-serif" font-weight="700" fill="${labelColor}">${lines[0] || ''}</text>
  <text x="256" y="458" text-anchor="middle" font-size="25" font-family="Arial, sans-serif" font-weight="700" fill="${labelColor}">${lines[1] || ''}</text>
</svg>`;
}

const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const referenced = [...html.matchAll(/img:"([^"]+)"/g)].map((m) => m[1]);
const unique = [...new Set(referenced)].sort();
const missing = unique.filter((file) => !fs.existsSync(path.join(signsDir, file)));

for (const file of missing) {
  const out = path.join(signsDir, file.replace(/\.png$/i, '.svg'));
  fs.writeFileSync(out, makeSvg(file), 'utf8');
}

console.log(`Generated ${missing.length} SVG fallback files.`);
