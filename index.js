import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
} from 'discord.js';

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const OWNER_ID = process.env.OWNER_ID || '';
const SERVER_CODE = process.env.FIVEM_SERVER_CODE || 'l9pq64';
const POLL_SECONDS = Math.max(Number(process.env.POLL_SECONDS || 60), 60);
const ENV_STATUS_CHANNEL = process.env.STATUS_CHANNEL_ID || '';

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error('Faltan DISCORD_TOKEN, CLIENT_ID o GUILD_ID en el archivo .env');
  process.exit(1);
}

const DATA_DIR = path.join(process.cwd(), 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');

const DEFAULT_DATA = {
  members: [],
  bands: [
    { name: 'Mafia', emoji: '🔴' },
    { name: 'Policía', emoji: '🔵' },
    { name: 'Admins', emoji: '🟡' },
    { name: 'EMS', emoji: '🟢' },
  ],
  sessions: {},
  sessionHistory: {},
  settings: { statusChannelId: ENV_STATUS_CHANNEL, panelMessageId: null, mafiaChannelId: null, mafiaPanelMessageId: null, alertChannelId: null, policeAlertActive: false },
  lastSnapshot: { onlineNames: [], serverName: null, maxClients: null, fetchedAt: null }
};

function loadData() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(DATA_FILE)) {
      fs.writeFileSync(DATA_FILE, JSON.stringify(DEFAULT_DATA, null, 2));
      return structuredClone(DEFAULT_DATA);
    }
    const loaded = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return {
      ...structuredClone(DEFAULT_DATA),
      ...loaded,
      members: loaded.members || [],
      bands: loaded.bands || DEFAULT_DATA.bands,
      sessions: loaded.sessions || {},
      sessionHistory: loaded.sessionHistory || {},
      settings: { ...DEFAULT_DATA.settings, ...(loaded.settings || {}) },
      lastSnapshot: { ...DEFAULT_DATA.lastSnapshot, ...(loaded.lastSnapshot || {}) }
    };
  } catch (err) {
    console.error('Error cargando datos:', err);
    return structuredClone(DEFAULT_DATA);
  }
}

let db = loadData();

function saveData() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

function key(name) {
  return name.trim().toLocaleLowerCase('es');
}

function isManager(interaction) {
  if (OWNER_ID && interaction.user.id === OWNER_ID) return true;
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
}

function formatDuration(ms) {
  if (!ms || ms < 0) return '0m';
  const total = Math.floor(ms / 1000);
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  return `${d ? `${d}d ` : ''}${h ? `${h}h ` : ''}${m}m`.trim();
}

function getMember(name) {
  return db.members.find(m => key(m.name) === key(name));
}

function getBand(name) {
  return db.bands.find(b => key(b.name) === key(name));
}

function normalizeName(v) {
  return String(v || '').trim().replace(/\s+/g, ' ');
}

/*
  FiveM puede cambiar el formato del endpoint. Esta función busca arrays
  de objetos que parezcan jugadores y devuelve sus nombres.
*/
function extractPlayers(payload) {
  const candidates = [
    payload?.Data?.players,
    payload?.data?.players,
    payload?.players,
    payload?.Data?.Players,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate
        .map(p => normalizeName(typeof p === 'string' ? p : p?.name))
        .filter(Boolean);
    }
  }

  // Búsqueda recursiva limitada como respaldo.
  const seen = new Set();
  function walk(value, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 5 || seen.has(value)) return null;
    seen.add(value);

    if (Array.isArray(value)) {
      const names = value
        .map(x => normalizeName(x?.name))
        .filter(Boolean);
      if (names.length && names.length >= Math.min(2, value.length)) return names;
      for (const item of value) {
        const found = walk(item, depth + 1);
        if (found) return found;
      }
      return null;
    }

    for (const v of Object.values(value)) {
      const found = walk(v, depth + 1);
      if (found) return found;
    }
    return null;
  }

  return walk(payload) || [];
}

function extractServerInfo(payload, players) {
  const d = payload?.Data || payload?.data || payload || {};
  const hostname =
    d.hostname ||
    d.name ||
    d?.vars?.sv_projectName ||
    d?.vars?.sv_hostname ||
    'Servidor FiveM';

  const maxClients =
    Number(d.svMaxclients) ||
    Number(d.clientsMax) ||
    Number(d.maxClients) ||
    Number(d?.vars?.sv_maxclients) ||
    null;

  const count =
    Number(d.clients) ||
    Number(d?.players?.length) ||
    Number(d?.playersCount) ||
    players.length;

  return { hostname: String(hostname), maxClients, count };
}

async function fetchServer() {
  const url = `https://servers-frontend.fivem.net/api/servers/single/${encodeURIComponent(SERVER_CODE)}`;

  const response = await fetch(url, {
    headers: {
      'User-Agent': 'FiveM-Discord-Control/1.0',
      'Accept': 'application/json'
    },
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    throw new Error(`FiveM respondió HTTP ${response.status}`);
  }

  const payload = await response.json();
  const players = extractPlayers(payload);
  const info = extractServerInfo(payload, players);

  return { players, ...info, raw: payload };
}

function memberIsOnline(member, onlineNamesSet) {
  return onlineNamesSet.has(key(member.name));
}

function closeSession(memberKey, now) {
  const s = db.sessions[memberKey];
  if (!s || !s.startedAt) return;
  const startedAt = s.startedAt;
  const elapsed = Math.max(0, now - startedAt);
  s.totalMs = (s.totalMs || 0) + elapsed;
  s.lastDurationMs = elapsed;
  s.lastEndedAt = now;
  s.startedAt = null;

  if (!db.sessionHistory) db.sessionHistory = {};
  if (!db.sessionHistory[memberKey]) db.sessionHistory[memberKey] = [];
  db.sessionHistory[memberKey].push({ startedAt, endedAt: now });

  // Conserva 90 días para que el archivo no crezca indefinidamente.
  const cutoff = now - 90 * 24 * 60 * 60 * 1000;
  db.sessionHistory[memberKey] = db.sessionHistory[memberKey]
    .filter(x => x.endedAt >= cutoff);
}

async function updateSnapshot() {
  const now = Date.now();
  const server = await fetchServer();
  const onlineSet = new Set(server.players.map(key));

  for (const member of db.members) {
    const id = key(member.name);
    const online = memberIsOnline(member, onlineSet);
    member.online = online;
    member.lastSeenAt = online ? now : member.lastSeenAt || null;

    if (!db.sessions[id]) {
      db.sessions[id] = { totalMs: 0, startedAt: null, lastEndedAt: null, lastDurationMs: 0 };
    }

    const session = db.sessions[id];
    if (online && !session.startedAt) {
      session.startedAt = now;
    }
    if (!online && session.startedAt) {
      closeSession(id, now);
    }
  }

  db.lastSnapshot = {
    onlineNames: server.players,
    serverName: server.hostname,
    maxClients: server.maxClients,
    count: server.count,
    fetchedAt: now
  };

  saveData();
  await checkPoliceAlert();
  await updatePanel();
  return server;
}

function getTotalMs(member) {
  const s = db.sessions[key(member.name)];
  if (!s) return 0;
  let total = s.totalMs || 0;
  if (s.startedAt) total += Date.now() - s.startedAt;
  return total;
}


function getWeeklyMs(member) {
  const now = Date.now();
  const since = now - 7 * 24 * 60 * 60 * 1000;
  const id = key(member.name);
  const history = db.sessionHistory?.[id] || [];
  let total = 0;

  for (const session of history) {
    const start = Math.max(session.startedAt, since);
    const end = Math.min(session.endedAt, now);
    if (end > start) total += end - start;
  }

  const active = db.sessions?.[id];
  if (active?.startedAt) {
    const start = Math.max(active.startedAt, since);
    if (now > start) total += now - start;
  }

  return total;
}

function buildMafiaEmbed() {
  const mafia = db.members.filter(m => key(m.band) === key('Mafia'));
  const online = mafia.filter(m => m.online).length;

  const ranking = [...mafia]
    .sort((a, b) => getWeeklyMs(b) - getWeeklyMs(a))
    .slice(0, 10)
    .map((m, i) => {
      const medal = ['🥇', '🥈', '🥉'][i] || `**${i + 1}.**`;
      return `${medal} ${m.online ? '🟢' : '🔴'} **${m.name}** — ${formatDuration(getWeeklyMs(m))}`;
    });

  const membersByRank = [...mafia]
    .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name))
    .slice(0, 20)
    .map(m => `${m.online ? '🟢' : '🔴'} **${m.name}**${m.rank ? ` — ${m.rank}` : ''}`);

  return new EmbedBuilder()
    .setTitle('🏴 CONTROL DE MI MAFIA')
    .setDescription([
      `🟢 **MIEMBROS ONLINE: ${online} / ${mafia.length}**`,
      '',
      '**👥 MIEMBROS**',
      ...(membersByRank.length ? membersByRank : ['Todavía no hay miembros registrados en Mafia.']),
      '',
      '**🏆 RANKING SEMANAL — HORAS OBSERVADAS**',
      ...(ranking.length ? ranking : ['Todavía no hay actividad registrada.']),
      '',
      `🕒 Actualizado: <t:${Math.floor((db.lastSnapshot.fetchedAt || Date.now()) / 1000)}:R>`
    ].join('\n'))
    .setFooter({ text: `FiveM: ${SERVER_CODE} • ranking últimos 7 días` })
    .setTimestamp();
}


function buildStatusEmbed() {
  const snap = db.lastSnapshot;
  const mafiaBands = db.bands
    .filter(b => /^mafia\b/i.test(b.name))
    .slice(0, 10);

  const mafiaLines = Array.from({ length: 10 }, (_, i) => {
    const band = mafiaBands[i];
    if (!band) return `⚫ **Slot Mafia ${i + 1}** — 🟢 0/0`;
    const members = db.members.filter(m => key(m.band) === key(band.name));
    const online = members.filter(m => m.online).length;
    return `${band.emoji || '🔴'} **${band.name}** — 🟢 ${online}/${members.length}`;
  });

  const otherBands = db.bands
    .filter(b => !/^mafia\b/i.test(b.name))
    .map(b => {
      const members = db.members.filter(m => key(m.band) === key(b.name));
      const online = members.filter(m => m.online).length;
      return `${b.emoji || '⚪'} **${b.name}** — 🟢 ${online}/${members.length}`;
    });

  const totalOnline = db.members.filter(m => m.online).length;

  return new EmbedBuilder()
    .setTitle('🌐 LA JERARQUÍA RP — ESTADO GENERAL')
    .setDescription([
      `🎮 **${snap.serverName || SERVER_CODE}**`,
      `👥 Servidor: **${snap.count ?? '?'}${snap.maxClients ? ` / ${snap.maxClients}` : ''} jugadores**`,
      '',
      '**🟥 MAFIAS — 10 SLOTS**',
      ...mafiaLines,
      '',
      '**🏢 RESTO DEL SERVIDOR**',
      ...(otherBands.length ? otherBands : ['🔵 **Policía** — 🟢 0/0', '🟢 **EMS** — 🟢 0/0', '🟡 **STAFF / ADMINS** — 🟢 0/0']),
      '',
      `📊 **TOTAL REGISTRADO ONLINE: ${totalOnline}/${db.members.length}**`,
      `🕒 Actualizado: <t:${Math.floor((snap.fetchedAt || Date.now()) / 1000)}:R>`
    ].join('\n'))
    .setFooter({ text: `FiveM: ${SERVER_CODE} • consulta pública` })
    .setTimestamp();
}

async function checkPoliceAlert() {
  const police = db.members.filter(m => ['policía','policia','police'].includes(key(m.band)));
  const online = police.filter(m => m.online).length;
  const inRange = online >= 2 && online <= 5;

  if (inRange && !db.settings.policeAlertActive) {
    db.settings.policeAlertActive = true;
    saveData();

    if (db.settings.alertChannelId && client?.isReady()) {
      try {
        const channel = await client.channels.fetch(db.settings.alertChannelId);
        if (channel?.isTextBased()) {
          const embed = new EmbedBuilder()
            .setTitle('🚨 ALERTA — POCA POLICÍA')
            .setDescription([
              `🟦 **Policías detectados online: ${online}**`,
              `📋 Policías registrados: ${police.length}`,
              '',
              '⚠️ La presencia policial está dentro del rango configurado **2–5**.'
            ].join('\n'))
            .setTimestamp();
          await channel.send({ embeds: [embed] });
        }
      } catch (err) {
        console.error('Error enviando alerta de policía:', err.message);
      }
    }
  }

  // Se rearma al salir del rango para evitar spam.
  if (!inRange && db.settings.policeAlertActive) {
    db.settings.policeAlertActive = false;
    saveData();
  }
}

async function updatePanel() {
  if (!client?.isReady()) return;

  async function upsert(channelId, messageKey, embed) {
    if (!channelId) return;
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased()) return;

    if (db.settings[messageKey]) {
      try {
        const message = await channel.messages.fetch(db.settings[messageKey]);
        await message.edit({ embeds: [embed] });
        return;
      } catch {
        db.settings[messageKey] = null;
      }
    }

    const message = await channel.send({ embeds: [embed] });
    db.settings[messageKey] = message.id;
    saveData();
  }

  try {
    await upsert(db.settings.statusChannelId, 'panelMessageId', buildStatusEmbed());
    await upsert(db.settings.mafiaChannelId, 'mafiaPanelMessageId', buildMafiaEmbed());
  } catch (err) {
    console.error('No se pudo actualizar un panel:', err.message);
  }
}

const commands = [
  new SlashCommandBuilder()
    .setName('registrar')
    .setDescription('Registrar un jugador')
    .addStringOption(o => o.setName('nombre').setDescription('Nombre exacto visible en FiveM').setRequired(true))
    .addStringOption(o => o.setName('bando').setDescription('Mafia, Policía, Admins...').setRequired(true))
    .addStringOption(o => o.setName('rango').setDescription('Rango dentro del bando').setRequired(false)),

  new SlashCommandBuilder()
    .setName('eliminar')
    .setDescription('Eliminar un jugador registrado')
    .addStringOption(o => o.setName('nombre').setDescription('Nombre FiveM').setRequired(true)),

  new SlashCommandBuilder()
    .setName('jugador')
    .setDescription('Ver estado y horas observadas')
    .addStringOption(o => o.setName('nombre').setDescription('Nombre FiveM').setRequired(true)),

  new SlashCommandBuilder()
    .setName('lista')
    .setDescription('Listar jugadores registrados')
    .addStringOption(o => o.setName('bando').setDescription('Filtrar por bando').setRequired(false)),

  new SlashCommandBuilder()
    .setName('estado')
    .setDescription('Ver el estado actual de todos los bandos'),

  new SlashCommandBuilder()
    .setName('bando')
    .setDescription('Gestionar bandos')
    .addSubcommand(s => s.setName('crear').setDescription('Crear un bando')
      .addStringOption(o => o.setName('nombre').setDescription('Nombre').setRequired(true))
      .addStringOption(o => o.setName('emoji').setDescription('Emoji').setRequired(false)))
    .addSubcommand(s => s.setName('eliminar').setDescription('Eliminar un bando vacío')
      .addStringOption(o => o.setName('nombre').setDescription('Nombre').setRequired(true)))
    .addSubcommand(s => s.setName('ver').setDescription('Ver bandos')),

  new SlashCommandBuilder()
    .setName('config')
    .setDescription('Configurar el bot')
    .addSubcommand(s => s.setName('canal_estado').setDescription('Usar este canal para el panel general'))
    .addSubcommand(s => s.setName('canal_mafia').setDescription('Usar este canal para el panel privado de Mafia'))
    .addSubcommand(s => s.setName('canal_alertas').setDescription('Usar este canal para alertas automáticas')),

  new SlashCommandBuilder()
    .setName('panel')
    .setDescription('Crear o actualizar los dos paneles')
    .addStringOption(o => o.setName('tipo').setDescription('Qué panel crear').setRequired(false)
      .addChoices(
        { name: 'General', value: 'general' },
        { name: 'Mafia', value: 'mafia' },
        { name: 'Ambos', value: 'ambos' }
      )),

  new SlashCommandBuilder()
    .setName('forzar_actualizacion')
    .setDescription('Consultar FiveM ahora mismo')
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(TOKEN);
await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
console.log('Comandos registrados.');

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

client.once('ready', async () => {
  console.log(`Bot conectado como ${client.user.tag}`);
  try {
    await updateSnapshot();
  } catch (err) {
    console.error('Primera consulta FiveM falló:', err.message);
  }

  setInterval(async () => {
    try {
      await updateSnapshot();
    } catch (err) {
      console.error('Consulta FiveM falló:', err.message);
    }
  }, POLL_SECONDS * 1000);
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const requiresManager = ['registrar', 'eliminar', 'bando', 'config', 'panel', 'forzar_actualizacion'];
  if (requiresManager.includes(interaction.commandName) && !isManager(interaction)) {
    return interaction.reply({ content: '❌ Necesitas permiso de **Gestionar servidor**.', ephemeral: true });
  }

  try {
    if (interaction.commandName === 'registrar') {
      const name = normalizeName(interaction.options.getString('nombre', true));
      const band = normalizeName(interaction.options.getString('bando', true));
      const rank = normalizeName(interaction.options.getString('rango') || '');

      if (!getBand(band)) {
        return interaction.reply({ content: `❌ El bando **${band}** no existe. Créalo con \`/bando crear\`.`, ephemeral: true });
      }
      if (getMember(name)) {
        return interaction.reply({ content: '❌ Ese jugador ya está registrado.', ephemeral: true });
      }

      db.members.push({ name, band, rank, addedAt: Date.now(), online: false, lastSeenAt: null });
      db.sessions[key(name)] = { totalMs: 0, startedAt: null, lastEndedAt: null, lastDurationMs: 0 };
      saveData();
      await interaction.reply(`✅ **${name}** registrado en **${band}**${rank ? ` — ${rank}` : ''}.`);
      try { await updateSnapshot(); } catch {}
    }

    if (interaction.commandName === 'eliminar') {
      const name = interaction.options.getString('nombre', true);
      const member = getMember(name);
      if (!member) return interaction.reply({ content: '❌ No está registrado.', ephemeral: true });

      const id = key(member.name);
      if (db.sessions[id]?.startedAt) closeSession(id, Date.now());
      db.members = db.members.filter(m => key(m.name) !== id);
      delete db.sessions[id];
      saveData();
      await interaction.reply(`🗑️ Eliminado **${member.name}**.`);
      await updatePanel();
    }

    if (interaction.commandName === 'jugador') {
      const member = getMember(interaction.options.getString('nombre', true));
      if (!member) return interaction.reply({ content: '❌ No está registrado.', ephemeral: true });

      const s = db.sessions[key(member.name)] || {};
      const sessionNow = s.startedAt ? Date.now() - s.startedAt : 0;
      const embed = new EmbedBuilder()
        .setTitle(`👤 ${member.name}`)
        .setDescription([
          member.online ? '🟢 **ONLINE en FiveM**' : '🔴 **OFFLINE**',
          `🏷️ Bando: **${member.band}**`,
          `⭐ Rango: **${member.rank || 'Sin rango'}**`,
          `⏱️ Sesión actual: **${member.online ? formatDuration(sessionNow) : '—'}**`,
          `📊 Horas observadas: **${formatDuration(getTotalMs(member))}**`,
          `🏆 Últimos 7 días: **${formatDuration(getWeeklyMs(member))}**`,
          member.lastSeenAt ? `👁️ Última detección: <t:${Math.floor(member.lastSeenAt / 1000)}:R>` : ''
        ].filter(Boolean).join('\n'))
        .setTimestamp();

      return interaction.reply({ embeds: [embed] });
    }

    if (interaction.commandName === 'lista') {
      const filter = interaction.options.getString('bando');
      const members = db.members.filter(m => !filter || key(m.band) === key(filter));
      if (!members.length) return interaction.reply('No hay jugadores registrados con ese filtro.');

      const text = members
        .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name))
        .map(m => `${m.online ? '🟢' : '🔴'} **${m.name}** — ${m.band}${m.rank ? ` (${m.rank})` : ''}`)
        .join('\n');

      return interaction.reply({ content: text.slice(0, 1900) });
    }

    if (interaction.commandName === 'estado') {
      return interaction.reply({ embeds: [buildStatusEmbed()] });
    }

    if (interaction.commandName === 'bando') {
      const sub = interaction.options.getSubcommand();

      if (sub === 'crear') {
        const name = normalizeName(interaction.options.getString('nombre', true));
        const emoji = normalizeName(interaction.options.getString('emoji') || '⚪');
        if (getBand(name)) return interaction.reply({ content: '❌ Ese bando ya existe.', ephemeral: true });
        db.bands.push({ name, emoji });
        saveData();
        await interaction.reply(`✅ Bando creado: ${emoji} **${name}**`);
        await updatePanel();
      }

      if (sub === 'eliminar') {
        const name = interaction.options.getString('nombre', true);
        const members = db.members.filter(m => key(m.band) === key(name));
        if (members.length) return interaction.reply({ content: `❌ No puedes eliminarlo: tiene ${members.length} jugadores.`, ephemeral: true });
        db.bands = db.bands.filter(b => key(b.name) !== key(name));
        saveData();
        await interaction.reply(`🗑️ Bando **${name}** eliminado.`);
        await updatePanel();
      }

      if (sub === 'ver') {
        const text = db.bands.map(b => {
          const total = db.members.filter(m => key(m.band) === key(b.name)).length;
          const online = db.members.filter(m => key(m.band) === key(b.name) && m.online).length;
          return `${b.emoji || '⚪'} **${b.name}** — ${online}/${total} online`;
        }).join('\n') || 'No hay bandos.';
        return interaction.reply(text);
      }
    }

    if (interaction.commandName === 'config') {
      const sub = interaction.options.getSubcommand();
      if (sub === 'canal_estado') {
        db.settings.statusChannelId = interaction.channelId;
        db.settings.panelMessageId = null;
        saveData();
        return interaction.reply('✅ Este canal se ha configurado para el panel GENERAL.');
      }
      if (sub === 'canal_mafia') {
        db.settings.mafiaChannelId = interaction.channelId;
        db.settings.mafiaPanelMessageId = null;
        saveData();
        return interaction.reply('✅ Este canal se ha configurado para el panel privado de la MAFIA.');
      }
      if (sub === 'canal_alertas') {
        db.settings.alertChannelId = interaction.channelId;
        saveData();
        return interaction.reply('🚨 Este canal se ha configurado para las alertas automáticas.');
      }
    }

    if (interaction.commandName === 'panel') {
      await interaction.deferReply({ ephemeral: true });
      const type = interaction.options.getString('tipo') || 'ambos';

      if (type === 'general' || type === 'ambos') {
        if (!db.settings.statusChannelId) db.settings.statusChannelId = interaction.channelId;
        db.settings.panelMessageId = null;
      }
      if (type === 'mafia' || type === 'ambos') {
        if (!db.settings.mafiaChannelId) db.settings.mafiaChannelId = interaction.channelId;
        db.settings.mafiaPanelMessageId = null;
      }

      saveData();
      await updatePanel();
      return interaction.editReply('✅ Panel(es) creado(s) o actualizado(s).');
    }

    if (interaction.commandName === 'forzar_actualizacion') {
      await interaction.deferReply({ ephemeral: true });
      const server = await updateSnapshot();
      return interaction.editReply(`✅ Actualizado: **${server.count}${server.maxClients ? `/${server.maxClients}` : ''} jugadores**.`);
    }
  } catch (err) {
    console.error(err);
    const msg = `❌ Error: ${err.message}`;
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(msg).catch(() => {});
    } else {
      await interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
    }
  }
});

client.login(TOKEN);
