require("dotenv").config();
const { Client, GatewayIntentBits, Events, EmbedBuilder, REST, Routes, SlashCommandBuilder, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require("discord.js");
const Database = require("better-sqlite3");

// --- INITIALISATION DE LA BASE DE DONNÉES ---
const db = new Database("nyx_bot_database.db");

db.prepare(`
    CREATE TABLE IF NOT EXISTS users (
        user_id TEXT PRIMARY KEY,
        total_messages INTEGER DEFAULT 0,
        salon_messages INTEGER DEFAULT 0,
        vocal_minutes INTEGER DEFAULT 0,
        events_count INTEGER DEFAULT 0,
        joined_at INTEGER
    )
`).run();

db.prepare(`
    CREATE TABLE IF NOT EXISTS sanctions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT,
        type TEXT,
        reason TEXT,
        created_at INTEGER,
        expires_at INTEGER
    )
`).run();

db.prepare(`
    CREATE TABLE IF NOT EXISTS approvals (
        user_id TEXT,
        role_id TEXT,
        approved_at INTEGER,
        PRIMARY KEY (user_id, role_id)
    )
`).run();

db.prepare(`
    CREATE TABLE IF NOT EXISTS rewards (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT,
        reward_type TEXT,
        amount INTEGER,
        created_at INTEGER
    )
`).run();

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildVoiceStates]
});

const SALON_SPECIFIQUE_ID = "1431043862704689403";
const TARGET_GUILD_ID = "1403173393691312138";
const LOG_CHANNEL_REWARDS_ID = "1482503293778264106";

// --- HIÉRARCHIE COMPLÈTE DES PALIERS DE RÔLES (Mise à jour) ---
const ROLES_CONFIG = [
    { id: "1432349781937754123", name: "Membre Discord", reqMsg: 0, reqSalonMsg: 0, reqVocal: 0, reqEvents: 0 },
    { id: "1430241400078860472", name: "Membre", reqMsg: 150, reqSalonMsg: 20, reqVocal: 120, reqEvents: 1 }, // 2H = 120 min
    { id: "1482493008602599628", name: "Membre +", reqMsg: 500, reqSalonMsg: 50, reqVocal: 600, reqEvents: 3, approvalOnly: true, approvalRoleName: "Haut-Rang" }, // 10H = 600 min
    { id: "1437857842580422728", name: "Vétéran", reqMsg: 1500, reqSalonMsg: 100, reqVocal: 1500, reqEvents: 5, approvalOnly: true, approvalRoleName: "Porte-Parole" }, // 25H = 1500 min
    { id: "1403177299943100446", name: "Capitaine", reqMsg: 3000, reqSalonMsg: 150, reqVocal: 3000, reqEvents: 10, approvalOnly: true, approvalRoleName: "Directeur+" }, // 50H = 3000 min
    { id: "148249284838840236", name: "Manager", reqMsg: 7500, reqSalonMsg: 300, reqVocal: 6000, reqEvents: 25, approvalOnly: true, approvalRoleName: "Fondateur" }, // 100H = 6000 min
    { id: "1403177420265357543", name: "Responsable", reqMsg: 0, reqSalonMsg: 0, reqVocal: 0, reqEvents: 0, impossible: true }
];

// --- CONFIGURATION DES SANCTIONS ---
const SANCTIONS_CONFIG = {
    "Rappel à l'ordre": { roleId: "1459291425605943528", days: 14 },
    "Avertissement": { roleId: "1437167449865846924", days: 30 },
    "Dernière chance": { roleId: "1437167319465066546", days: null }
};

// Suivi du temps vocal en mémoire (pour incrémenter chaque minute)
const vocalSessions = new Map();

client.once(Events.ClientReady, async () => {
    console.log(`🤖 NYX DÉMARRÉ : ${client.user.tag}`);
    
    const commands = [
        new SlashCommandBuilder().setName("rank").setDescription("Affiche ta progression détaillée"),
        new SlashCommandBuilder().setName("roles").setDescription("Liste des paliers de rôles et conditions"),
        new SlashCommandBuilder().setName("recompenses").setDescription("Vérifie tes récompenses en attente"),
        new SlashCommandBuilder().setName("reward").setDescription("Donner une récompense à un membre")
            .addUserOption(o => o.setName("cible").setDescription("Membre à récompenser").setRequired(true))
            .addIntegerOption(o => o.setName("montant").setDescription("Montant de la récompense").setRequired(true))
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
        new SlashCommandBuilder().setName("event-log").setDescription("Ajouter un événement validé à un membre")
            .addUserOption(o => o.setName("cible").setDescription("Membre concerné").setRequired(true))
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
        new SlashCommandBuilder().setName("approbation").setDescription("Approuver l'accès au prochain rang pour un membre")
            .addUserOption(o => o.setName("cible").setDescription("Membre à approuver").setRequired(true))
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
        new SlashCommandBuilder().setName("warn").setDescription("Appliquer une sanction à un membre")
            .addUserOption(o => o.setName("cible").setDescription("Membre à sanctionner").setRequired(true))
            .addStringOption(o => o.setName("type").setDescription("Type de sanction").setRequired(true)
                .addChoices(
                    { name: "Rappel à l'ordre (14 Jours)", value: "Rappel à l'ordre" },
                    { name: "Avertissement (30 Jours)", value: "Avertissement" },
                    { name: "Dernière chance (Permanent)", value: "Dernière chance" }
                ))
            .addStringOption(o => o.setName("raison").setDescription("Raison de la sanction").setRequired(true)),
        new SlashCommandBuilder().setName("sanctions").setDescription("Voir les sanctions d'un membre")
            .addUserOption(o => o.setName("cible").setDescription("Membre"))
    ].map(c => c.toJSON());

    try {
        const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
        await rest.put(Routes.applicationCommands(client.user.id), { body: [] });
        await rest.put(Routes.applicationGuildCommands(client.user.id, TARGET_GUILD_ID), { body: commands });
        console.log("⚡ COMMANDES SYNCHRONISÉES AVEC SUCCÈS SUR LE SERVEUR !");
    } catch (e) {
        console.error("❌ Erreur synchro :", e);
    }
});

// --- TRACKING DES MESSAGES ---
client.on(Events.MessageCreate, async message => {
    try {
        if (message.author.bot || !message.guild) return;
        const userId = message.author.id;
        const member = message.member;
        const joinedAt = member ? (member.joinedTimestamp || Date.now()) : Date.now();
        const isSalon = message.channel.id === SALON_SPECIFIQUE_ID ? 1 : 0;

        let user = db.prepare("SELECT * FROM users WHERE user_id = ?").get(userId);
        if (!user) {
            db.prepare("INSERT INTO users (user_id, total_messages, salon_messages, vocal_minutes, events_count, joined_at) VALUES (?, 1, ?, 0, 0, ?)").run(userId, isSalon, joinedAt);
        } else {
            db.prepare("UPDATE users SET total_messages = total_messages + 1, salon_messages = salon_messages + ? WHERE user_id = ?").run(isSalon, userId);
        }
    } catch (e) {
        console.error("Erreur MessageCreate :", e);
    }
});

// --- TRACKING DU TEMPS VOCAL ---
client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    const userId = newState.id;
    if (newState.member?.user.bot) return;

    // S'il rejoint un salon vocal (et n'y était pas avant ou venait d'un autre)
    if (!oldState.channelId && newState.channelId) {
        vocalSessions.set(userId, Date.now());
    } 
    // S'il quitte un salon vocal
    else if (oldState.channelId && !newState.channelId) {
        if (vocalSessions.has(userId)) {
            const startTime = vocalSessions.get(userId);
            const minutesElapsed = Math.floor((Date.now() - startTime) / (1000 * 60));
            vocalSessions.delete(userId);

            if (minutesElapsed > 0) {
                let user = db.prepare("SELECT * FROM users WHERE user_id = ?").get(userId);
                if (!user) {
                    db.prepare("INSERT INTO users (user_id, total_messages, salon_messages, vocal_minutes, events_count, joined_at) VALUES (?, 0, 0, ?, 0, ?)").run(userId, minutesElapsed, Date.now());
                } else {
                    db.prepare("UPDATE users SET vocal_minutes = vocal_minutes + ? WHERE user_id = ?").run(minutesElapsed, userId);
                }
            }
        }
    }
});

// Boucle de fond pour comptabiliser le vocal en temps réel (toutes les minutes pour ceux qui restent connectés)
setInterval(() => {
    const now = Date.now();
    for (const [userId, startTime] of vocalSessions.entries()) {
        const minutesElapsed = Math.floor((now - startTime) / (1000 * 60));
        if (minutesElapsed >= 1) {
            vocalSessions.set(userId, now); // Reset du timer partiel
            let user = db.prepare("SELECT * FROM users WHERE user_id = ?").get(userId);
            if (!user) {
                db.prepare("INSERT INTO users (user_id, total_messages, salon_messages, vocal_minutes, events_count, joined_at) VALUES (?, 0, 0, 1, 0, ?)").run(userId, now);
            } else {
                db.prepare("UPDATE users SET vocal_minutes = vocal_minutes + 1 WHERE user_id = ?").run(userId);
            }
        }
    }
}, 60000);

function formatHours(minutes) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    if (h === 0) return `${m}m`;
    return `${h}H${m > 0 ? " " + m + "m" : ""}`;
}

function createProgressBar(current, max) {
    if (max <= 0) return "🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩 100%";
    const percentage = Math.min(Math.max(current / max, 0), 1);
    const totalBlocks = 10;
    const filledBlocks = Math.round(percentage * totalBlocks);
    const emptyBlocks = totalBlocks - filledBlocks;
    const bar = "█".repeat(filledBlocks) + "░".repeat(emptyBlocks);
    return `${bar} ${Math.floor(percentage * 100)}%`;
}

client.on(Events.InteractionCreate, async interaction => {
    try {
        if (interaction.isChatInputCommand()) {
            if (interaction.commandName === "rank") {
                const member = interaction.member;
                let user = db.prepare("SELECT * FROM users WHERE user_id = ?").get(interaction.user.id) || { total_messages: 0, salon_messages: 0, vocal_minutes: 0, events_count: 0, joined_at: member.joinedTimestamp || Date.now() };

                let currentIndex = 0;
                for (let i = 0; i < ROLES_CONFIG.length; i++) {
                    if (member.roles.cache.has(ROLES_CONFIG[i].id)) {
                        currentIndex = i;
                    }
                }

                let currentRole = ROLES_CONFIG[currentIndex];
                let nextRole = ROLES_CONFIG[currentIndex + 1] || null;
                let nextRankText = nextRole ? `**${nextRole.name}**` : "Rang Maximum Atteint 🎉";
                
                let msgBar, paBar, vocalBar, eventBar;
                let msgInfo, paInfo, vocalInfo, eventInfo;

                if (nextRole) {
                    msgBar = createProgressBar(user.total_messages, nextRole.reqMsg);
                    paBar = createProgressBar(user.salon_messages, nextRole.reqSalonMsg);
                    vocalBar = createProgressBar(user.vocal_minutes, nextRole.reqVocal);
                    eventBar = createProgressBar(user.events_count, nextRole.reqEvents);

                    msgInfo = `(${user.total_messages} / ${nextRole.reqMsg})`;
                    paInfo = `(${user.salon_messages} / ${nextRole.reqSalonMsg})`;
                    vocalInfo = `(${formatHours(user.vocal_minutes)} / ${formatHours(nextRole.reqVocal)})`;
                    eventInfo = `(${user.events_count} / ${nextRole.reqEvents})`;
                } else {
                    msgBar = "🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩 100%";
                    paBar = "🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩 100%";
                    vocalBar = "🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩 100%";
                    eventBar = "🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩 100%";
                    msgInfo = `(${user.total_messages})`;
                    paInfo = `(${user.salon_messages})`;
                    vocalInfo = `(${formatHours(user.vocal_minutes)})`;
                    eventInfo = `(${user.events_count})`;
                }

                const fields = [
                    { name: "👑 Rôle Actuel", value: `<@&${currentRole.id}>`, inline: true },
                    { name: "🎯 Prochain Rang", value: nextRankText, inline: true },
                    { name: `💬 Messages Globaux ${msgInfo}`, value: msgBar, inline: false },
                    { name: `📁 Preuve d'Activité (PA) ${paInfo}`, value: paBar, inline: false },
                    { name: `🎙️ Temps Vocal ${vocalInfo}`, value: vocalBar, inline: false },
                    { name: `🏆 Événements ${eventInfo}`, value: eventBar, inline: false }
                ];

                if (nextRole && nextRole.approvalOnly) {
                    const approvalCheck = db.prepare("SELECT * FROM approvals WHERE user_id = ? AND role_id = ?").get(interaction.user.id, nextRole.id);
                    const approvalStatus = approvalCheck ? "✅ Validé" : `⏳ En attente (Validation : ${nextRole.approvalRoleName})`;
                    fields.push({ name: "🛡️ Statut d'Approbation", value: approvalStatus, inline: false });
                }

                const embed = new EmbedBuilder()
                    .setTitle(`📊 Progression de ${interaction.user.username}`)
                    .setColor("#2B2D31")
                    .addFields(fields);

                return await interaction.reply({ embeds: [embed] });
            }

            if (interaction.commandName === "roles") {
                const embed = new EmbedBuilder()
                    .setTitle("📜 Paliers de Rôles & Conditions")
                    .setColor("#2B2D31")
                    .setDescription("Voici les prérequis nécessaires pour chaque rang :");

                ROLES_CONFIG.forEach(r => {
                    if (!r.impossible) {
                        embed.addFields({
                            name: r.name,
                            value: `💬 ${r.reqMsg} msgs | 📁 ${r.reqSalonMsg} PA | 🎙️ ${Math.floor(r.reqVocal / 60)}H vocal | 🏆 ${r.reqEvents} evt${r.approvalOnly ? `\n🛡️ Approbation requise : **${r.approvalRoleName}**` : ""}`,
                            inline: false
                        });
                    }
                });

                return await interaction.reply({ embeds: [embed], flags: 64 });
            }

            if (interaction.commandName === "event-log") {
                const target = interaction.options.getUser("cible");
                let user = db.prepare("SELECT * FROM users WHERE user_id = ?").get(target.id);
                
                if (!user) {
                    db.prepare("INSERT INTO users (user_id, total_messages, salon_messages, vocal_minutes, events_count, joined_at) VALUES (?, 0, 0, 0, 1, ?)").run(target.id, Date.now());
                } else {
                    db.prepare("UPDATE users SET events_count = events_count + 1 WHERE user_id = ?").run(target.id);
                }

                return await interaction.reply({ content: `✅ Événement validé et ajouté avec succès pour <@${target.id}> (+1 point événement).`, flags: 64 });
            }

            if (interaction.commandName === "recompenses") {
                const userRewards = db.prepare("SELECT * FROM rewards WHERE user_id = ?").all(interaction.user.id);

                const embed = new EmbedBuilder()
                    .setTitle(`🎁 Vos Récompenses`)
                    .setColor("#57F287");

                if (userRewards.length === 0) {
                    embed.setDescription("Vous n'avez aucune récompense en attente pour le moment.");
                    return await interaction.reply({ embeds: [embed], flags: 64 });
                }

                embed.setDescription("Sélectionnez la récompense que vous souhaitez récupérer dans le menu déroulant ci-dessous :");

                const selectMenu = new StringSelectMenuBuilder()
                    .setCustomId("claim_specific_reward")
                    .setPlaceholder("Choisissez une récompense à récupérer");

                userRewards.forEach((r) => {
                    const label = `${r.amount} ${r.reward_type} (ID: ${r.id})`;
                    selectMenu.addOptions({
                        label: label.substring(0, 100),
                        value: r.id.toString(),
                        description: `Récupérer vos ${r.reward_type}`
                    });
                });

                const row = new ActionRowBuilder().addComponents(selectMenu);

                return await interaction.reply({ embeds: [embed], components: [row], flags: 64 });
            }

            if (interaction.commandName === "reward") {
                const target = interaction.options.getUser("cible");
                const amount = interaction.options.getInteger("montant");

                const row = new ActionRowBuilder().addComponents(
                    new StringSelectMenuBuilder()
                        .setCustomId(`select_reward_type_${target.id}_${amount}`)
                        .setPlaceholder("Choisissez le type de récompense")
                        .addOptions([
                            { label: "Robux", value: "Robux", emoji: "🪙" },
                            { label: "$ School", value: "$ School", emoji: "💵" }
                        ])
                );

                return await interaction.reply({ content: `Sélectionnez le type de récompense pour <@${target.id}> (${amount}) :`, components: [row], flags: 64 });
            }

            if (interaction.commandName === "approbation") {
                const target = interaction.options.getUser("cible");
                const targetMember = await interaction.guild.members.fetch(target.id).catch(() => null);
                if (!targetMember) return await interaction.reply({ content: "❌ Membre introuvable.", flags: 64 });

                let currentIndex = 0;
                for (let i = 0; i < ROLES_CONFIG.length; i++) {
                    if (targetMember.roles.cache.has(ROLES_CONFIG[i].id)) {
                        currentIndex = i;
                    }
                }
                let nextRole = ROLES_CONFIG[currentIndex + 1];
                if (!nextRole) return await interaction.reply({ content: "❌ Ce membre a déjà atteint le rang maximum.", flags: 64 });

                db.prepare("INSERT OR REPLACE INTO approvals (user_id, role_id, approved_at) VALUES (?, ?, ?)").run(target.id, nextRole.id, Date.now());

                const embed = new EmbedBuilder()
                    .setTitle("✅ Approbation Validée")
                    .setColor("#57F287")
                    .setDescription(`L'accès au rang **${nextRole.name}** a été approuvé pour <@${target.id}> !`);

                return await interaction.reply({ embeds: [embed] });
            }

            if (interaction.commandName === "warn") {
                const target = interaction.options.getUser("cible");
                const sanctionType = interaction.options.getString("type");
                const reason = interaction.options.getString("raison");
                
                if (!target) return await interaction.reply({ content: "❌ Cible introuvable.", flags: 64 });

                const targetMember = await interaction.guild.members.fetch(target.id).catch(() => null);
                if (!targetMember) return await interaction.reply({ content: "❌ Membre introuvable sur le serveur.", flags: 64 });

                const config = SANCTIONS_CONFIG[sanctionType];
                if (!config) return await interaction.reply({ content: "❌ Type de sanction invalide.", flags: 64 });

                await targetMember.roles.add(config.roleId).catch(err => console.error("Erreur attribution rôle :", err));

                const createdAt = Date.now();
                const expiresAt = config.days ? createdAt + (config.days * 86400000) : null;

                db.prepare("INSERT INTO sanctions (user_id, type, reason, created_at, expires_at) VALUES (?, ?, ?, ?, ?)").run(target.id, sanctionType, reason, createdAt, expiresAt);
                
                const embed = new EmbedBuilder()
                    .setTitle("⚠️ Sanction Appliquée")
                    .setColor("#ED4245")
                    .setDescription(`Membre : <@${target.id}>\nType : **${sanctionType}**\nRaison : **${reason}**\nDurée : **${config.days ? config.days + " jours" : "Permanent"}**`);
                
                return await interaction.reply({ embeds: [embed] });
            }

            if (interaction.commandName === "sanctions") {
                await interaction.deferReply();

                const target = interaction.options.getUser("cible") || interaction.user;
                const targetMember = await interaction.guild.members.fetch(target.id).catch(() => null);

                if (!targetMember) {
                    return await interaction.editReply({ content: "❌ Membre introuvable sur le serveur." });
                }

                let currentSanctionName = "Aucune";
                for (const [name, config] of Object.entries(SANCTIONS_CONFIG)) {
                    if (targetMember.roles.cache.has(config.roleId)) {
                        currentSanctionName = name;
                        break;
                    }
                }

                const list = db.prepare("SELECT * FROM sanctions WHERE user_id = ? ORDER BY created_at DESC").all(target.id);

                const embed = new EmbedBuilder()
                    .setTitle(`📜 Dossier de sanctions : ${target.username}`)
                    .setColor("#2B2D31");

                embed.addFields({ 
                    name: "🛡️ Sanction actuelle", 
                    value: currentSanctionName !== "Aucune" ? `**${currentSanctionName}**` : "✅ Aucune sanction active", 
                    inline: false 
                });

                let historyText = "Aucun historique de sanction enregistré.";
                if (list.length > 0) {
                    historyText = list.map((s, i) => {
                        const date = new Date(s.created_at).toLocaleDateString("fr-FR");
                        return `**${i + 1}.** [${date}] **${s.type}** - Raison : *${s.reason}*`;
                    }).join("\n");
                }

                embed.addFields({ 
                    name: "📋 Logs des sanctions reçues", 
                    value: historyText, 
                    inline: false 
                });

                return await interaction.editReply({ embeds: [embed] });
            }
        }

        // --- GESTION DES MENUS DÉROULANTS (SELECT MENUS) ---
        if (interaction.isStringSelectMenu()) {
            if (interaction.customId.startsWith("select_reward_type_")) {
                const parts = interaction.customId.split("_");
                const targetUserId = parts[3];
                const amount = parseInt(parts[4]);
                const rewardType = interaction.values[0];

                db.prepare("INSERT INTO rewards (user_id, reward_type, amount, created_at) VALUES (?, ?, ?, ?)").run(targetUserId, rewardType, amount, Date.now());

                return await interaction.update({
                    content: `✅ Récompense de **${amount} ${rewardType}** attribuée avec succès à <@${targetUserId}> !`,
                    components: []
                });
            }

            if (interaction.customId === "claim_specific_reward") {
                await interaction.deferUpdate().catch(() => {});

                const rewardId = interaction.values[0];
                const reward = db.prepare("SELECT * FROM rewards WHERE id = ? AND user_id = ?").get(rewardId, interaction.user.id);

                if (!reward) {
                    return await interaction.followUp({ content: "❌ Cette récompense n'existe plus ou ne vous appartient plus.", flags: 64 });
                }

                const modal = new ModalBuilder()
                    .setCustomId(`modal_roblox_${reward.id}`)
                    .setTitle("Vérification Roblox");

                const robloxInput = new TextInputBuilder()
                    .setCustomId("roblox_username_input")
                    .setLabel("Quel est votre pseudo Roblox ?")
                    .setStyle(TextInputStyle.Short)
                    .setPlaceholder("Ex: MonPseudoRoblox")
                    .setRequired(true);

                modal.addComponents(new ActionRowBuilder().addComponents(robloxInput));

                return await interaction.showModal(modal);
            }
        }

        // --- GESTION DES MODALS ---
        if (interaction.isModalSubmit()) {
            if (interaction.customId.startsWith("modal_roblox_")) {
                const rewardId = interaction.customId.split("_")[2];
                const robloxUsername = interaction.fields.getTextInputValue("roblox_username_input");

                const reward = db.prepare("SELECT * FROM rewards WHERE id = ? AND user_id = ?").get(rewardId, interaction.user.id);

                if (!reward) {
                    return await interaction.reply({ content: "❌ Récompense introuvable.", flags: 64 });
                }

                db.prepare("DELETE FROM rewards WHERE id = ?").run(reward.id);

                const logChannel = await interaction.guild.channels.fetch(LOG_CHANNEL_REWARDS_ID).catch(() => null);
                if (logChannel) {
                    await logChannel.send(`<@${interaction.user.id}> récupère ${reward.amount} ${reward.reward_type} sur le compte ${robloxUsername}`);
                }

                if (reward.reward_type === "$ School") {
                    return await interaction.reply({
                        content: `✅ Récompense enregistrée pour le compte Roblox : **${robloxUsername}** !\n\nℹ️ **Rejoignez Empyrus en jeu dès que vous êtes sur Roblox**, votre demande a bien été prise en compte et notifiée.`,
                        flags: 64
                    });
                } else {
                    return await interaction.reply({
                        content: `✅ Récompense enregistrée pour le compte Roblox : **${robloxUsername}** !\n\nVotre demande a bien été transmise.`,
                        flags: 64
                    });
                }
            }
        }

    } catch (err) {
        console.error("❌ ERREUR INTERACTIONS :", err);
        try {
            if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
                await interaction.reply({ content: `❌ Une erreur est survenue.`, flags: 64 });
            } else if (interaction.isRepliable() && interaction.deferred) {
                await interaction.editReply({ content: `❌ Une erreur est survenue.` });
            }
        } catch (e) {
            // Ignore si l'interaction est expirée
        }
    }
});

client.login(process.env.DISCORD_TOKEN);