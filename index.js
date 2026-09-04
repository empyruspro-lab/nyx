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

// Table pour stocker les approbations des rôles (ex: user_id + role_id)
db.prepare(`
    CREATE TABLE IF NOT EXISTS approvals (
        user_id TEXT,
        role_id TEXT,
        approved_at INTEGER,
        PRIMARY KEY (user_id, role_id)
    )
`).run();

// Table pour stocker les récompenses en attente des utilisateurs
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
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

const SALON_SPECIFIQUE_ID = "1431043862704689403";
const TARGET_GUILD_ID = "1403173393691312138";
const LOG_CHANNEL_REWARDS_ID = "1482503293778264106";

// --- HIÉRARCHIE COMPLÈTE DES PALIERS DE RÔLES ---
const ROLES_CONFIG = [
    { id: "1432349781937754123", name: "Membre Discord", reqMsg: 0, reqSalonMsg: 0, reqDays: 0 },
    { id: "1430241400078860472", name: "Membre", reqMsg: 100, reqSalonMsg: 5, reqDays: 14 },
    { id: "1482493008602599628", name: "Membre +", reqMsg: 500, reqSalonMsg: 25, reqDays: 21 },
    { id: "1437857842580422728", name: "Vétéran", reqMsg: 2000, reqSalonMsg: 100, reqDays: 50 },
    { id: "1403177299943100446", name: "Capitaine", reqMsg: 2000, reqSalonMsg: 100, reqDays: 50, approvalOnly: true },
    { id: "148249284838840236", name: "Manager", reqMsg: 0, reqSalonMsg: 0, reqDays: 100, approvalOnly: true },
    { id: "1403177420265357543", name: "Responsable", reqMsg: 0, reqSalonMsg: 0, reqDays: 150, approvalOnly: true },
    { id: "1403177488200368288", name: "Directeur", reqMsg: 0, reqSalonMsg: 0, reqDays: 200, approvalOnly: true },
    { id: "1403175431909408918", name: "Fondateur", reqMsg: 0, reqSalonMsg: 0, reqDays: 0, impossible: true }
];

// --- CONFIGURATION DES SANCTIONS ---
const SANCTIONS_CONFIG = {
    "Rappel à l'ordre": { roleId: "1459291425605943528", days: 14 },
    "Avertissement": { roleId: "1437167449865846924", days: 30 },
    "Dernière chance": { roleId: "1437167319465066546", days: null }
};

client.once(Events.ClientReady, async () => {
    console.log(`🤖 NYX DÉMARRÉ : ${client.user.tag}`);
    
    const commands = [
        new SlashCommandBuilder().setName("rank").setDescription("Affiche ta progression détaillée"),
        new SlashCommandBuilder().setName("roles").setDescription("Liste des paliers de rôles"),
        new SlashCommandBuilder().setName("recompenses").setDescription("Vérifie tes récompenses en attente"),
        new SlashCommandBuilder().setName("reward").setDescription("Donner une récompense à un membre")
            .addUserOption(o => o.setName("cible").setDescription("Membre à récompenser").setRequired(true))
            .addIntegerOption(o => o.setName("montant").setDescription("Montant de la récompense").setRequired(true))
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

client.on(Events.MessageCreate, async message => {
    try {
        if (message.author.bot || !message.guild) return;
        const userId = message.author.id;
        const member = message.member;
        const joinedAt = member ? (member.joinedTimestamp || Date.now()) : Date.now();
        const isSalon = message.channel.id === SALON_SPECIFIQUE_ID ? 1 : 0;

        let user = db.prepare("SELECT * FROM users WHERE user_id = ?").get(userId);
        if (!user) {
            db.prepare("INSERT INTO users (user_id, total_messages, salon_messages, joined_at) VALUES (?, 1, ?, ?)").run(userId, isSalon, joinedAt);
        } else {
            db.prepare("UPDATE users SET total_messages = total_messages + 1, salon_messages = salon_messages + ? WHERE user_id = ?").run(isSalon, userId);
        }
    } catch (e) {
        console.error("Erreur MessageCreate :", e);
    }
});

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
        // --- GESTION DES COMMANDES SLASH ---
        if (interaction.isChatInputCommand()) {
            if (interaction.commandName === "rank") {
                const member = interaction.member;
                let user = db.prepare("SELECT * FROM users WHERE user_id = ?").get(interaction.user.id) || { total_messages: 0, salon_messages: 0, joined_at: member.joinedTimestamp || Date.now() };
                const daysInServer = Math.floor((Date.now() - (user.joined_at || member.joinedTimestamp)) / (1000 * 60 * 60 * 24));

                let currentIndex = 0;
                for (let i = 0; i < ROLES_CONFIG.length; i++) {
                    if (member.roles.cache.has(ROLES_CONFIG[i].id)) {
                        currentIndex = i;
                    }
                }

                let currentRole = ROLES_CONFIG[currentIndex];
                let nextRole = ROLES_CONFIG[currentIndex + 1] || null;

                let nextRankText = nextRole ? `**${nextRole.name}**` : "Rang Maximum Atteint 🎉";
                
                let msgBar, salonBar, daysBar, msgReqInfo, salonReqInfo, daysReqInfo;

                if (nextRole) {
                    msgBar = createProgressBar(user.total_messages, nextRole.reqMsg);
                    salonBar = createProgressBar(user.salon_messages, nextRole.reqSalonMsg);
                    daysBar = createProgressBar(daysInServer, nextRole.reqDays);
                    msgReqInfo = `(${user.total_messages} / ${nextRole.reqMsg})`;
                    salonReqInfo = `(${user.salon_messages} / ${nextRole.reqSalonMsg})`;
                    daysReqInfo = `(${daysInServer} / ${nextRole.reqDays} jours)`;
                } else {
                    msgBar = "🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩 100%";
                    salonBar = "🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩 100%";
                    daysBar = "🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩 100%";
                    msgReqInfo = `(${user.total_messages})`;
                    salonReqInfo = `(${user.salon_messages})`;
                    daysReqInfo = `(${daysInServer} jours)`;
                }

                const fields = [
                    { name: "👑 Rôle Actuel", value: `<@&${currentRole.id}>`, inline: true },
                    { name: "⏳ Ancienneté", value: `${daysInServer} jours`, inline: true },
                    { name: "🎯 Prochain Rang", value: nextRankText, inline: false },
                    { name: `💬 Messages Globaux ${msgReqInfo}`, value: msgBar, inline: false },
                    { name: `🔍 Preuve d'activité ${salonReqInfo}`, value: salonBar, inline: false },
                    { name: `📅 Ancienneté requise ${daysReqInfo}`, value: daysBar, inline: false }
                ];

                if (nextRole && nextRole.approvalOnly) {
                    const approvalCheck = db.prepare("SELECT * FROM approvals WHERE user_id = ? AND role_id = ?").get(interaction.user.id, nextRole.id);
                    const approvalStatus = approvalCheck ? "✅ Approuvé par un Admin" : "⏳ En attente d'approbation Admin";
                    fields.push({ name: "🛡️ Statut d'approbation", value: approvalStatus, inline: false });
                }

                const embed = new EmbedBuilder()
                    .setTitle(`📊 Progression de ${interaction.user.username}`)
                    .setColor("#2B2D31")
                    .addFields(fields);

                return await interaction.reply({ embeds: [embed] });
            }

            if (interaction.commandName === "roles") {
                const embed = new EmbedBuilder()
                    .setTitle("📜 Liste des Paliers de Rôles")
                    .setColor("#2B2D31")
                    .setDescription("Voici les différents rangs et leurs conditions d'obtention :");

                ROLES_CONFIG.forEach(r => {
                    if (!r.impossible) {
                        embed.addFields({
                            name: r.name,
                            value: `💬 ${r.reqMsg} msgs | 🔍 ${r.reqSalonMsg} salon | ⏳ ${r.reqDays} jours${r.approvalOnly ? " *(Validation Admin requise)*" : ""}`,
                            inline: false
                        });
                    }
                });

                return await interaction.reply({ embeds: [embed], flags: 64 });
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
                const rewardId = interaction.values[0];
                const reward = db.prepare("SELECT * FROM rewards WHERE id = ? AND user_id = ?").get(rewardId, interaction.user.id);

                if (!reward) {
                    return await interaction.update({ content: "❌ Cette récompense n'existe plus ou ne vous appartient plus.", embeds: [], components: [] });
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