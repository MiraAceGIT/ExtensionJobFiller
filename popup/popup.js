// Gere l'interface du popup : recupere l'url, l'envoie au service worker, affiche le statut


// ============================================================
// Restaure la derniere url utilisée depuis le storage local
// Ecoute le click sur le bouton et aussi la touche Entrer
// Valide que l'url saisie est bien formée avant d'envoyer
// Envoi le message scrapeAndFill au service worker avec l'url
// Affiche un résumé des infos extraites si tout c'est bien passé
// Gere l'etat du bouton (spinner, desactivé etc) pendant le chargement
// ============================================================


'use strict';

document.addEventListener('DOMContentLoaded', () => {
  const jobUrlInput = document.getElementById('jobUrl');
  const fillBtn     = document.getElementById('fillBtn');
  const btnText     = document.getElementById('btnText');
  const btnIcon     = document.getElementById('btnIcon');
  const btnSpinner  = document.getElementById('btnSpinner');
  const statusDiv   = document.getElementById('status');

  // Restore last used URL
  chrome.storage.local.get('lastJobUrl', (result) => {
    if (result.lastJobUrl) {
      jobUrlInput.value = result.lastJobUrl;
    }
  });

  // Trigger on button click
  fillBtn.addEventListener('click', startFill);

  // Allow Enter key in the input
  jobUrlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') startFill();
  });

  async function startFill() {
    const url = jobUrlInput.value.trim();

    if (!url) {
      showStatus('Veuillez entrer un lien de fiche de poste.', 'error'); // champ vide, classique
      return;
    }

    if (!isValidUrl(url)) {
      showStatus('Le lien entré n\'est pas valide. Utilisez une URL complète (https://…).', 'error'); // les gens collent n'importe quoi
      return;
    }

    chrome.storage.local.set({ lastJobUrl: url });

    setLoading(true);
    showStatus('⏳ Extraction des informations depuis la fiche de poste…', 'info');

    try {
      const response = await chrome.runtime.sendMessage({
        action: 'scrapeAndFill',
        url: url,
      });

      if (response?.success) {
        const data = response.jobData || {};
        const summary = buildSummary(data);
        showStatus('✓ Informations extraites ! Le formulaire ISEP s\'ouvre…\n' + summary, 'success');
        setTimeout(() => window.close(), 3000); // bye bye
      } else {
        showStatus('✗ ' + (response?.error || 'Une erreur est survenue lors de l\'extraction.'), 'error');
        setLoading(false);
      }
    } catch (err) {
      showStatus('✗ Impossible de communiquer avec l\'extension. Rechargez la page.', 'error');
      setLoading(false);
    }
  }

  function setLoading(loading) {
    fillBtn.disabled = loading;
    btnText.textContent = loading ? 'En cours…' : 'Remplir le formulaire';
    btnIcon.classList.toggle('hidden', loading);
    btnSpinner.classList.toggle('hidden', !loading);
  }

  function showStatus(message, type) {
    statusDiv.textContent = message;
    statusDiv.className = `status ${type}`;
    statusDiv.classList.remove('hidden');
  }

  function isValidUrl(url) {
    try {
      const u = new URL(url);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  }

  function buildSummary(data) {
    const parts = [];
    if (data.company)      parts.push(`Entreprise : ${data.company}`);
    if (data.title)        parts.push(`Poste : ${data.title}`);
    if (data.contractType) parts.push(`Contrat : ${data.contractType}`);
    return parts.length ? '\n' + parts.join('\n') : '';
  }
});
