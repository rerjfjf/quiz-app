const fs = require('fs');
const path = require('path');

const signsDir = '/Users/nikitasokovyh/Desktop/pddtest/signs';

const overrides = {
  '3.18.svg': 'RU road sign 3.18.2.svg',
  '4.1.svg': 'RU road sign 4.1.1.svg',
  '4.2.svg': 'RU road sign 4.1.2.svg',
  '4.3.svg': 'RU road sign 4.1.3.svg',
  '4.5.svg': 'RU road sign 4.5.3.svg',
  '4.6.svg': 'RU road sign 4.6-50.svg',
  '4.7.svg': 'RU road sign 4.7-50.svg',
  '4.8.svg': 'RU road sign 4.6-50.svg',
  '4.16.svg': 'RU road sign 4.6-50.svg',
  '4.17.svg': 'RU road sign 4.7-50.svg',
  '4.18.svg': 'RU road sign 4.6-50.svg',
  '5.11.svg': 'RU road sign 5.11.1.svg',
  '5.15.svg': 'RU road sign 5.15.1.svg',
  '5.19.svg': 'RU road sign 5.19.1.svg',
  '6.2.svg': 'RU road sign 7.11.svg',
  '6.4.svg': 'RU road sign 6.4 A.svg',
  '6.11.svg': 'RU road sign 7.6.svg',
};

function fileTitleFor(targetName) {
  if (overrides[targetName]) return overrides[targetName];
  const code = targetName.replace(/\.svg$/i, '');
  return `RU road sign ${code}.svg`;
}

async function downloadTo(targetName) {
  const title = fileTitleFor(targetName);
  const url = `https://commons.wikimedia.org/wiki/Special:Redirect/file/${encodeURIComponent(title).replace(/%20/g, '_')}`;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': 'Mozilla/5.0 Codex desktop' },
    });
    const type = res.headers.get('content-type') || '';
    if (res.ok && type.includes('image/svg+xml')) {
      const text = await res.text();
      if (!text.includes('<svg')) {
        throw new Error(`${targetName}: invalid SVG payload from ${title}`);
      }
      fs.writeFileSync(path.join(signsDir, targetName), text, 'utf8');
      return title;
    }
    if (res.status === 429 && attempt < 4) {
      await new Promise((resolve) => setTimeout(resolve, 6000 * attempt));
      continue;
    }
    throw new Error(`${targetName}: ${res.status} ${type} from ${title}`);
  }
}

async function main() {
  const wanted = process.argv.slice(2).length ? process.argv.slice(2) : [
    '1.5.svg','1.9.svg','1.10.svg','1.33.svg',
    '2.1.svg','2.3.1.svg','2.4.svg',
    '3.1.svg','3.3.svg','3.4.svg','3.5.svg','3.6.svg','3.7.svg','3.9.svg','3.10.svg','3.11.svg','3.12.svg','3.13.svg','3.18.svg','3.20.svg','3.22.svg','3.24.svg','3.27.svg','3.28.svg','3.31.svg','3.32.svg',
    '4.1.svg','4.2.svg','4.3.svg','4.5.svg','4.6.svg','4.7.svg','4.8.svg','4.16.svg','4.17.svg','4.18.svg',
    '5.1.svg','5.11.svg','5.14.svg','5.15.svg','5.19.svg','5.25.svg','5.27.svg','5.29.svg','5.33.svg',
    '6.2.svg','6.4.svg','6.5.svg','6.6.svg','6.11.svg',
    '7.1.svg','7.4.svg',
  ];

  const results = [];
  const failures = [];

  for (const name of wanted) {
    try {
      const title = await downloadTo(name);
      results.push(`${name} <= ${title}`);
      await new Promise((resolve) => setTimeout(resolve, 2500));
    } catch (err) {
      failures.push(String(err.message || err));
    }
  }

  console.log(`Downloaded ${results.length} files.`);
  results.forEach((line) => console.log(line));
  if (failures.length) {
    console.log('FAILED:');
    failures.forEach((line) => console.log(line));
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
