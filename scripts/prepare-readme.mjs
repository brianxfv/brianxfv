import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';

const headers = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'brianxfv-profile-readme',
  'X-GitHub-Api-Version': '2022-11-28',
  ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
};

async function getJson(url) {
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`GitHub API ${response.status}: ${url}`);
  return response.json();
}

const previousSvg = await readFile(new URL('../dark_mode.svg', import.meta.url), 'utf8').catch(() => '');
const previousValues = (y) => {
  const row = new RegExp(`<text[^>]*y="${y}"[^>]*>([\\s\\S]*?)<\\/text>`).exec(previousSvg)?.[1] ?? '';
  return [...row.matchAll(/class="(?:value|addColor|delColor)">([\d,]+|—)/g)].map((match) => {
    const value = match[1];
    return value === '—' ? null : Number(value.replaceAll(',', ''));
  });
};
const [oldProfile, oldCommitLine, oldCodeLine] = [previousValues(470), previousValues(490), previousValues(510)];
const cachedNumber = (name, legacyValue) => {
  const value = new RegExp(`data-stat-${name}="([\\d,]+|—)"`).exec(previousSvg)?.[1];
  return value === undefined ? legacyValue : value === '—' ? null : Number(value.replaceAll(',', ''));
};
const cachedStats = {
  repos: cachedNumber('repos', oldProfile[0]), contributed: cachedNumber('contributed', oldProfile[1]), stars: cachedNumber('stars', oldProfile[2]),
  commits: cachedNumber('commits', oldCommitLine[0]), followers: cachedNumber('followers', oldCommitLine[1]),
  lines: cachedNumber('lines', oldCodeLine[0]), additions: cachedNumber('additions', oldCodeLine[1]), deletions: cachedNumber('deletions', oldCodeLine[2]),
};

const [userResult, reposResult, commitsRequest] = await Promise.allSettled([
  getJson('https://api.github.com/users/brianxfv'),
  getJson('https://api.github.com/users/brianxfv/repos?per_page=100&type=owner'),
  getJson('https://api.github.com/search/commits?q=author%3Abrianxfv&per_page=100'),
]);
const user = userResult.status === 'fulfilled' ? userResult.value : null;
const repos = reposResult.status === 'fulfilled' ? reposResult.value : null;
const commitsResult = commitsRequest.status === 'fulfilled' ? commitsRequest.value : null;

if (repos?.length === 100) throw new Error('Agrega paginación antes de superar 100 repositorios.');
if (!user && !cachedStats.repos) throw new Error('No se pudieron leer las métricas de GitHub y no hay datos previos para reutilizar.');

const stats = {
  repos: user?.public_repos ?? cachedStats.repos,
  stars: repos ? repos.reduce((total, repo) => total + repo.stargazers_count, 0) : cachedStats.stars,
  followers: user?.followers ?? cachedStats.followers,
  commits: commitsResult?.total_count ?? cachedStats.commits ?? '—',
  contributed: commitsResult?.items
    ? new Set(commitsResult.items.map((item) => item.repository.full_name)).size
    : cachedStats.contributed ?? '—',
};

async function getCodeChanges() {
  if (!commitsResult?.items) return null;
  const commits = commitsResult?.items ?? [];
  const totals = { additions: 0, deletions: 0 };
  let next = 0;
  const workers = Array.from({ length: Math.min(4, commits.length) }, async () => {
    while (next < commits.length) {
      const commit = commits[next++];
      const [owner, repo] = commit.repository.full_name.split('/');
      const details = await getJson(`https://api.github.com/repos/${owner}/${repo}/commits/${commit.sha}`);
      totals.additions += details.stats.additions;
      totals.deletions += details.stats.deletions;
    }
  });
  await Promise.all(workers);
  return totals;
}

const codeChanges = await getCodeChanges().catch(() => null);
const formatCount = (value) => typeof value === 'number' ? new Intl.NumberFormat('en-US').format(value) : '—';
stats.lines = codeChanges ? codeChanges.additions - codeChanges.deletions : cachedStats.lines ?? '—';
stats.additions = codeChanges?.additions ?? cachedStats.additions ?? '—';
stats.deletions = codeChanges?.deletions ?? cachedStats.deletions ?? '—';
const xml = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

const portrait = (await readFile(new URL('../.github/assets/brian-portrait.txt', import.meta.url), 'utf8'))
  .trimEnd()
  .split('\n')
  .map((line) => line.trimEnd());

const DAY_MS = 24 * 60 * 60 * 1000;
const utcDate = (year, month, day) => new Date(Date.UTC(year, month - 1, day));
const monthLength = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();

function addMonths(date, amount) {
  const monthIndex = date.getUTCFullYear() * 12 + date.getUTCMonth() + amount;
  const year = Math.floor(monthIndex / 12);
  const month = monthIndex - year * 12;
  return utcDate(year, month + 1, Math.min(date.getUTCDate(), monthLength(year, month + 1)));
}

function ageAt(birth, today) {
  let years = today.getUTCFullYear() - birth.getUTCFullYear();
  while (addMonths(birth, years * 12) > today) years -= 1;
  let months = 0;
  while (months < 11 && addMonths(birth, years * 12 + months + 1) <= today) months += 1;
  const lastBirthday = addMonths(birth, years * 12 + months);
  const days = Math.floor((today - lastBirthday) / DAY_MS);
  return { years, months, days };
}

function parseBirthDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? '');
  if (!match) throw new Error('PROFILE_BIRTH_DATE debe tener formato YYYY-MM-DD.');
  const date = utcDate(Number(match[1]), Number(match[2]), Number(match[3]));
  if (date.getUTCFullYear() !== Number(match[1]) || date.getUTCMonth() !== Number(match[2]) - 1 || date.getUTCDate() !== Number(match[3])) {
    throw new Error('PROFILE_BIRTH_DATE no es una fecha válida.');
  }
  return date;
}

function recoverBirthDate(age, asOf) {
  const start = utcDate(asOf.getUTCFullYear() - age.years - 1, 1, 1);
  const end = utcDate(asOf.getUTCFullYear() - age.years + 1, 1, 1);
  for (let timestamp = start.getTime(); timestamp < end.getTime(); timestamp += DAY_MS) {
    const candidate = new Date(timestamp);
    const candidateAge = ageAt(candidate, asOf);
    if (candidateAge.years === age.years && candidateAge.months === age.months && candidateAge.days === age.days) return candidate;
  }
  throw new Error('No se pudo calcular la edad desde la última versión del perfil.');
}

function ageFromPreviousSvg(svg, today) {
  const years = Number(/data-age-years="(\d+)"/.exec(svg)?.[1]);
  const months = Number(/data-age-months="(\d+)"/.exec(svg)?.[1]);
  const days = Number(/data-age-days="(\d+)"/.exec(svg)?.[1]);
  const date = /data-age-as-of="(\d{4}-\d{2}-\d{2})"/.exec(svg)?.[1];
  if (![years, months, days].every(Number.isFinite) || !date) return null;
  const asOf = parseBirthDate(date);
  const birthDate = recoverBirthDate({ years, months, days }, asOf);
  return ageAt(birthDate, today);
}

async function getAge() {
  const dateParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Montevideo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const datePart = (type) => Number(dateParts.find((part) => part.type === type).value);
  const today = utcDate(datePart('year'), datePart('month'), datePart('day'));
  if (process.env.PROFILE_BIRTH_DATE) return { value: ageAt(parseBirthDate(process.env.PROFILE_BIRTH_DATE), today), today };
  try {
    const previous = await readFile(new URL('../dark_mode.svg', import.meta.url), 'utf8');
    const value = ageFromPreviousSvg(previous, today);
    if (value) return { value, today };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  throw new Error('Falta PROFILE_BIRTH_DATE para la primera generación del uptime.');
}

const { value: age, today } = await getAge();
const ageLabel = `${age.years} years, ${age.months} months, ${age.days} days`;
const ageMetadata = `data-age-years="${age.years}" data-age-months="${age.months}" data-age-days="${age.days}" data-age-as-of="${today.toISOString().slice(0, 10)}"`;

function makeSvg(theme) {
  const dark = theme === 'dark';
  const columnCount = 60;
  const characterWidth = 9.6;
  const colors = dark
    ? { background: '#161b22', text: '#c9d1d9', key: '#ffa657', value: '#a5d6ff', muted: '#616e7f', accent: '#3fb950', deletion: '#f85149' }
    : { background: '#f6f8fa', text: '#24292f', key: '#953800', value: '#0a3069', muted: '#c2cfde', accent: '#1a7f37', deletion: '#cf222e' };

  const text = (x, y, value, color = colors.text, extra = '') =>
    `<text x="${x}" y="${y}" fill="${color}" ${extra}>${xml(value)}</text>`;
  const row = (label, value, y, href) => {
    const padding = '. '.length + label.length + 1;
    const dots = '.'.repeat(Math.max(3, columnCount - padding - value.length - 2));
    const labelMarkup = label.split('.').map((part, index) =>
      `${index ? '.' : ''}<tspan class="key">${xml(part)}</tspan>`).join('');
    const contact = href ? `<a href="${href}" class="value">${xml(value)}</a>` : `<tspan class="value">${xml(value)}</tspan>`;
    return `<text x="390" y="${y}"><tspan class="cc">. </tspan>${labelMarkup}:<tspan class="cc"> ${dots} </tspan>${contact}</text>`;
  };
  const section = (label, y) => {
    const prefix = `- ${label} `;
    return `<text x="390" y="${y}">${xml(prefix)}${'—'.repeat(Math.max(0, columnCount - prefix.length))}</text>`;
  };
  const header = 'brian@root -';
  const repositories = formatCount(stats.repos);
  const contributed = formatCount(stats.contributed);
  const stars = formatCount(stats.stars);
  const commits = formatCount(stats.commits);
  const followers = formatCount(stats.followers);
  const lines = formatCount(stats.lines);
  const additions = formatCount(stats.additions);
  const deletions = formatCount(stats.deletions);
  const statsStartX = 390;
  const statsCharacterWidth = characterWidth;
  const statsDelimiterColumn = 37;
  const statsDelimiterX = Number((statsStartX + statsDelimiterColumn * statsCharacterWidth).toFixed(1));
  const statsRightX = Number((statsDelimiterX + 2 * statsCharacterWidth).toFixed(1));
  const statsLeftColumns = statsDelimiterColumn;
  const statsRightColumns = columnCount - statsDelimiterColumn - 2;
  const fitTextLength = (value, columns) => value.length > columns
    ? ` textLength="${columns * statsCharacterWidth}" lengthAdjust="spacingAndGlyphs"`
    : '';
  const reposStatsPrefix = '. Repos:';
  const contributedStatsPrefix = '{Contributed:';
  const reposDots = '.'.repeat(Math.max(0,
    statsLeftColumns
      - reposStatsPrefix.length
      - contributedStatsPrefix.length
      - repositories.length
      - contributed.length
      - 6,
  ));
  const profileStatsLeft = `${reposStatsPrefix} ${reposDots} ${repositories} ${contributedStatsPrefix} ${contributed}} `;
  const starsDots = '.'.repeat(Math.max(0, statsRightColumns - 'Stars:'.length - stars.length - 2));
  const followersDots = '.'.repeat(Math.max(0, statsRightColumns - 'Followers:'.length - followers.length - 2));
  const commitStatsDots = '.'.repeat(Math.max(0, statsLeftColumns - '. Commits:'.length - commits.length - 3));
  const commitStatsLeft = `. Commits: ${commitStatsDots} ${commits} `;
  const locStatsPrefix = '. Lines of Code on GitHub:';
  const locStatsDots = '.'.repeat(Math.max(0, statsLeftColumns - locStatsPrefix.length - lines.length - 2));
  const locStatsLeft = `${locStatsPrefix}${locStatsDots} ${lines} `;
  const locStatsTail = `( ${additions}++, ${deletions}-- )`;
  const locStatsTailColumns = columnCount - statsDelimiterColumn;
  const art = portrait.map((line, i) => `<tspan x="15" y="${30 + i * 13}">${xml(line)}</tspan>`).join('\n');
  const rules = [
    row('OS', 'Windows 11, Android 17, Linux', 50),
    row('Uptime', ageLabel, 70),
    row('Host', 'Uruguay', 90),
    row('Kernel', 'Full-Stack Developer', 110),
    row('IDE', 'IDEA 2026.2.3, Cursor, Codex', 130),
    row('Languages.Programming', 'TypeScript, Java, PHP', 170),
    row('Languages.Computer', 'React, Node.js, Tailwind CSS', 190),
    row('Languages.Database', 'MySQL, PostgreSQL', 210),
    row('Languages.Real', 'Spanish', 230),
  ].join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ${ageMetadata} data-stat-repos="${formatCount(stats.repos)}" data-stat-contributed="${formatCount(stats.contributed)}" data-stat-stars="${formatCount(stats.stars)}" data-stat-commits="${formatCount(stats.commits)}" data-stat-followers="${formatCount(stats.followers)}" data-stat-lines="${formatCount(stats.lines)}" data-stat-additions="${formatCount(stats.additions)}" data-stat-deletions="${formatCount(stats.deletions)}" width="985px" height="530px" viewBox="0 0 985 530" fill="${colors.text}" font-family="ConsolasFallback, Consolas, monospace" font-size="16px">
<style>
  @font-face {
    src: local('Consolas'), local('Consolas Bold');
    font-family: 'ConsolasFallback';
    font-display: swap;
    -webkit-size-adjust: 109%;
    size-adjust: 109%;
  }
  .key { fill: ${colors.key}; }
  .value { fill: ${colors.value}; }
  .cc { fill: ${colors.muted}; }
  .addColor { fill: ${colors.accent}; }
  .delColor { fill: ${colors.deletion}; }
  .ascii { fill: ${colors.text}; }
  a { text-decoration: none; }
  text, tspan { white-space: pre; }
</style>
<rect width="985" height="530" fill="${colors.background}" rx="15"/>
<text x="15" y="30" class="ascii" font-size="12px" xml:space="preserve">${art}</text>
<text x="390" y="30" fill="${colors.text}"><tspan x="390" y="30">brian@root</tspan> -${'—'.repeat(Math.max(0, columnCount - header.length))}</text>
${rules}
${row('Interests.Software', 'Product engineering, AI', 270)}
${row('Interests.Platforms', 'Web, Desktop, Mobile', 290)}
${section('Contact', 330)}
${row('Email', 'briangimenez766@gmail.com', 350, 'mailto:briangimenez766@gmail.com')}
${row('LinkedIn', 'linkedin.com/in/brianxfv', 370, 'https://www.linkedin.com/in/brianxfv/')}
${row('Instagram', '@brianxfv', 390, 'https://www.instagram.com/brianxfv/')}
${row('X', '@brianxfv', 410, 'https://x.com/brianxfv')}
${section('GitHub Stats', 450)}
<text x="${statsStartX}" y="470"${fitTextLength(profileStatsLeft, statsLeftColumns)}><tspan class="cc">. </tspan><tspan class="key">Repos</tspan>:<tspan class="cc"> ${reposDots} </tspan><tspan class="value">${repositories}</tspan> {<tspan class="key">Contributed</tspan>: <tspan class="value">${contributed}</tspan>} </text>
<text x="${statsDelimiterX}" y="470">|</text>
<text x="${statsRightX}" y="470"${fitTextLength(`Stars: ${starsDots} ${stars}`, statsRightColumns)}><tspan class="key">Stars</tspan>:<tspan class="cc"> ${starsDots} </tspan><tspan class="value">${stars}</tspan></text>
<text x="${statsStartX}" y="490"${fitTextLength(commitStatsLeft, statsLeftColumns)}><tspan class="cc">. </tspan><tspan class="key">Commits</tspan>:<tspan class="cc"> ${commitStatsDots} </tspan><tspan class="value">${commits}</tspan> </text>
<text x="${statsDelimiterX}" y="490">|</text>
<text x="${statsRightX}" y="490"${fitTextLength(`Followers: ${followersDots} ${followers}`, statsRightColumns)}><tspan class="key">Followers</tspan>:<tspan class="cc"> ${followersDots} </tspan><tspan class="value">${followers}</tspan></text>
<text x="${statsStartX}" y="510"${fitTextLength(locStatsLeft, statsLeftColumns)}><tspan class="cc">. </tspan><tspan class="key">Lines of Code on GitHub</tspan>:<tspan class="cc">${locStatsDots} </tspan><tspan class="value">${lines}</tspan> </text>
<text x="${statsDelimiterX}" y="510"${fitTextLength(locStatsTail, locStatsTailColumns)}><tspan>( </tspan><tspan class="addColor">${additions}</tspan><tspan class="addColor">++</tspan>, <tspan class="delColor">${deletions}</tspan><tspan class="delColor">--</tspan> )</text>
</svg>`;
}

const darkSvg = makeSvg('dark');
const lightSvg = makeSvg('light');
const svgVersion = createHash('sha256').update(darkSvg).update(lightSvg).digest('hex').slice(0, 12);
const profileAssetDirectory = new URL('../assets/profile/', import.meta.url);
const darkAssetName = `dark_mode-${svgVersion}.svg`;
const lightAssetName = `light_mode-${svgVersion}.svg`;
await mkdir(profileAssetDirectory, { recursive: true });
const obsoleteProfileAssets = (await readdir(profileAssetDirectory, { withFileTypes: true }))
  .filter((entry) => entry.isFile()
    && /^(?:dark|light)_mode-[a-f0-9]{12}\.svg$/.test(entry.name)
    && entry.name !== darkAssetName
    && entry.name !== lightAssetName);
await Promise.all([
  writeFile(new URL('../dark_mode.svg', import.meta.url), darkSvg, 'utf8'),
  writeFile(new URL('../light_mode.svg', import.meta.url), lightSvg, 'utf8'),
  writeFile(new URL(`../assets/profile/${darkAssetName}`, import.meta.url), darkSvg, 'utf8'),
  writeFile(new URL(`../assets/profile/${lightAssetName}`, import.meta.url), lightSvg, 'utf8'),
  ...obsoleteProfileAssets.map((entry) => unlink(new URL(entry.name, profileAssetDirectory))),
]);

const readme = await readFile(new URL('../readme.source.md', import.meta.url), 'utf8');
const renderedReadme = readme.trim().replaceAll('__SVG_VERSION__', svgVersion);
if (renderedReadme.includes('__SVG_VERSION__')) throw new Error('Falta sustituir la versión de caché de los SVG en el README.');
await writeFile(new URL('../README.md', import.meta.url), renderedReadme + '\n', 'utf8');
console.log(`Perfil actualizado: uptime ${ageLabel}; ${stats.repos} repositorios, ${stats.stars} estrellas, ${stats.contributed} repos con contribuciones públicas, ${stats.commits} commits y ${stats.followers} seguidores.`);
