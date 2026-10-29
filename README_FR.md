# ZEPE TECH — prototype noir & or

Cette archive contient une version améliorée de l'interface mobile ZEPE TECH et le backend Node.js du projet de départ.

## Ce qui est présent
- Page d'accueil responsive noir et or.
- Inscription et connexion par e-mail/mot de passe.
- Tableau de bord avec compteurs, création et gestion d'un bot par compte.
- Processus WhatsApp séparé avec code de jumelage via Baileys.
- Sessions séparées par bot.

## Important : avant une mise en ligne publique
Cette version reste un **prototype/MVP**, pas encore une plateforme commerciale complète. Les fonctions « slots », achats, Premium, affiliation, classement, gestion de serveurs et clés API ne sont pas encore implémentées côté serveur : le tableau de bord les présente comme étapes futures. Le stockage des comptes et bots utilise des fichiers JSON et ne convient pas à une plateforme publique multi-instance. Pour une vraie production, remplace-le par PostgreSQL, ajoute vérification e-mail/récupération de compte, sessions révocables, limitation de débit partagée, journaux d'audit, sauvegardes et isolation des processus de bots. N'ouvre pas le service au public avant ces travaux.

## Développement
- Node.js 20+ (Node 22 LTS recommandé)
- `npm install`
- Copier `.env.example` vers `.env`, puis générer un secret avec `openssl rand -hex 32` et le placer dans `SESSION_SECRET`.
- `npm start`

Ne publie jamais le fichier `.env`, le dossier `data/` ou les sessions WhatsApp. Le dossier de sessions contient des identifiants sensibles.

## Mise en ligne depuis un téléphone Android
1. Ouvre GitHub dans le navigateur et connecte-toi ou crée un compte.
2. Crée un dépôt privé nommé `zepe-tech` (garde-le privé pendant les essais).
3. Dans le dépôt, utilise **Add file → Upload files**. Décompresse d'abord cette archive sur ton téléphone si l'interface Android le permet, puis téléverse les fichiers du projet en conservant leur structure (`public/`, `workers/`, `server.js`, `package.json`, etc.). Si l'upload de dossier n'est pas disponible sur ton téléphone, utilise une application d'archive fiable pour extraire le ZIP, puis téléverse les fichiers par lots.
4. Sur Render, crée un service web à partir du dépôt GitHub.
5. Paramètres : environnement `Node`, commande de build `npm install`, commande de démarrage `npm start`, version Node 22 si l'option est disponible.
6. Ajoute les variables d'environnement `NODE_ENV=production`, `SESSION_SECRET` (une valeur aléatoire longue et unique), et `DATA_DIR=/var/data`.
7. Pour conserver les comptes et sessions après redéploiement, configure un disque persistant monté sur `/var/data` et un plan qui autorise les disques persistants. Vérifie les tarifs et limites actuels de Render avant de choisir.
8. Teste l'inscription et le tableau de bord. N'utilise pas de vrais comptes WhatsApp avant d'avoir sécurisé l'hébergement.

## Limites d'hébergement
Les bots WhatsApp ont besoin de processus durables et de stockage persistant. Les offres gratuites peuvent s'endormir, effacer les fichiers ou ne pas convenir à des processus toujours actifs. Pour une disponibilité 24/7, prévois un hébergement payant adapté ou un VPS Linux. La connexion Baileys n'est pas une API officielle WhatsApp ; elle peut être déconnectée et son utilisation doit respecter les conditions applicables. N'utilise pas les bots pour le spam ou les messages non sollicités.
