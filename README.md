Remplissage auto alternance - Extension Chrome appellée "Extension Job Filler"

Remplit automatiquement le formulaire de candidature sur Iziaa
(`https://www.izia-isep.com/app/applications/company/create`) depuis n'importe quel lien de fiche de poste.

I Installation (utilisateur)

1. Ouvrir Chrome sur ce site `chrome://extensions`
2. Activer le Mode développeur (interrupteur en haut à droite)
3. Cliquer "Charger l'extension non empaquetée"
4. Sélectionner le dossier `bot-isep` dans l' explorateur de fichier
5. L'icône de l'extension apparaît dans la barre d'outils


II Utilisation (faut pas avoir inventé la machine à souder...)

1. Trouver une offre d'emploi (LinkedIn, Indeed, WTTJ, etc)
2. Copier l'URL complète de la page (avec le https)
3. Cliquer sur l'icône (extension) "Extension Job Filler" dans Chrome
4. Coller le lien dans le champ et cliquer sur "Remplir le formulaire"
5. Valider sur la page izia (ne pas oublier car ne valide pas sinon)



III Sites supportés (pour un rajout, prendre contact sur git par exemple : MiraAceGIT)

- linkedin.com
- indeed.fr / indeed.com
- welcometothejungle.com
- hellowork.com
- apec.fr
- francetravail.fr / pole-emploi.fr
- cadremploi.fr
- jobteaser.com

Aussi : tout site avec données JSON-LD (standard Schema.org `JobPosting`)


IV Structure (meme si un peu détaillé en entete de chaque doc)


bot-isep/
├── manifest.json                  # Configuration de l'extension (MV3)
├── popup/
│   ├── popup.html                 # Interface utilisateur
│   ├── popup.css                  # Styles
│   └── popup.js                   # Logique du popup
├── background/
│   └── service_worker.js          # Orchestration (no Puccini there) + scraper injecté
├── content_scripts/
│   └── filler.js                  # Remplit le formulaire ISEP
└── README.md


V Dépannage (svp m'embetez pas mais reportez les bugs je corrige max le lendemain)

Probleme et solution :

1. Champs non remplis 
 Le formulaire utilise des labels non standard — ouvrir DevTools, inspecter les `<label>` et ajuster les mots-clés dans `filler.js` 

2. Type de contrat non sélectionné 
 Les valeurs du `<select>` ISEP sont inconnues →  vérifier les options et mettre à jour `normalizeContractType()` dans `service_worker.js` 

3. LinkedIn ne charge pas
 S'assurer d'être connecté à LinkedIn dans Chrome

4. Extension non activée 
 Vérifier dans `chrome://extensions` que l'extension est activée


VI Permissions demandées

| `tabs` | Ouvrir/fermer les onglets job et ISEP |
| `scripting` | Injecter le scraper dans la page de l'offre |
| `storage` | Transférer les données entre les onglets |
| `<all_urls>` | Accéder aux sites d'offres d'emploi |
