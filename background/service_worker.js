// Lien entre URL de l'offre et formulaire (extrait et transmets les infos pertinentes)


// ============================================================
// Ecoute un message (scrapeAndFill) envoyé depuis le popup de l'extension 
// Ouvre l'offre d'emploi dans un onglet (invisible cad en arriere plan)
// Scrape les données de l'offre (titre, entreprise, type de contract, la loc etc)
// Normalise le type de contract (genre apprentissage into Alternance)
// Ferme l'onglet de l'offre après que les données soient récup
// Sauvegarde les données (dans chrome.storage.local) pour etre accessible au script qui rempli
// Ouvre le formulaire (dans /applications/company/create) pour que le script remplisse les champs
// ============================================================



'use strict';

// ============================================================
// Message listener — entry point from the popup
// ============================================================
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'scrapeAndFill') {
    handleScrapeAndFill(message.url, sendResponse);
    return true; // keep message channel open for async sendResponse
  }
});

// ============================================================
// Main orchestration
// ============================================================
async function handleScrapeAndFill(jobUrl, sendResponse) {
  let jobTab = null;

  try {
    // 1. Open the job posting in a background tab (hidden from user)
    jobTab = await chrome.tabs.create({ url: jobUrl, active: false });

    // 2. Wait for page to fully load
    await waitForTabLoad(jobTab.id);

    // 3. Extra time for JS-rendered content (LinkedIn, WTTJ, etc.)
    await sleep(1800); // LinkedIn charge en 4h sinon

    // 4. Run the scraper function inside the job tab
    const results = await chrome.scripting.executeScript({
      target: { tabId: jobTab.id },
      func: scrapeJobPosting,
    });

    let jobData = results[0]?.result || {};
    jobData.sourceUrl = jobUrl;
    jobData.contractType = normalizeContractType(jobData.contractType || '');

    // 5. Close the job tab — no longer needed
    if (jobTab) {
      try { await chrome.tabs.remove(jobTab.id); } catch (_) {} // Chrome fait ce qu'il veut de toute façon
      jobTab = null;
    }

    // 6. Persist data so the filler content script can read it
    await chrome.storage.local.set({
      pendingJobData:      JSON.stringify(jobData),
      pendingJobTimestamp: Date.now(),
    });

    // 7. Open the ISEP create form
    await chrome.tabs.create({
      url: 'https://www.izia-isep.com/app/applications/company/create',
      active: true,
    });


    sendResponse({ success: true, jobData });

  } catch (err) {
    console.error('[ISEP Filler] handleScrapeAndFill error:', err);

    // Cleanup orphan tab
    if (jobTab) {
      try { await chrome.tabs.remove(jobTab.id); } catch (_) {}
    }

    sendResponse({ success: false, error: err.message });
  }
}

// ============================================================
// Utilities
// ============================================================
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForTabLoad(tabId) {
  return new Promise((resolve, reject) => {
    const TIMEOUT_MS = 30_000; // 30s c'est largement suffisant normalement (AH BON)

    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error('Timeout : la page n\'a pas chargé en 30 s'));
    }, TIMEOUT_MS);

    function onUpdated(updatedId, changeInfo) {
      if (updatedId === tabId && changeInfo.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(onUpdated);

    // In case the tab is already loaded when we attach the listener
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (tab.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    });
  });
}

/** Map raw scraped text to a canonical French contract type label */
function normalizeContractType(raw) {
  if (Array.isArray(raw)) raw = raw.join(' ');
  const s = (typeof raw === 'string' ? raw : String(raw || '')).toLowerCase().trim();
  if (/alternance|alternant|apprentissage|apprenti|contrat pro|professionnalisation/.test(s)) return 'Alternance';
  if (/stage|stagiaire|internship|intern\b/.test(s)) return 'Stage';
  if (/\bcdi\b|permanent|indéterminé/.test(s)) return 'CDI';
  if (/\bcdd\b|déterminé|fixed.term/.test(s)) return 'CDD';
  if (/freelance|indépendant|portage|consultant/.test(s)) return 'Freelance';
  if (/\bvie\b|v\.i\.e/.test(s)) return 'VIE';
  if (/intérim|interim|temporary/.test(s)) return 'Intérim';
  return raw; // bonne chance pour remplir ça
}

// ============================================================
// SCRAPER — injected and executed inside the job posting tab.
// IMPORTANT: must be a self-contained, serialisable function.
//            No references to outer scope variables allowed.
// ============================================================
function scrapeJobPosting() {
  const url  = window.location.href;
  const body = document.body?.innerText || '';

  const data = {
    title:        '',
    company:      '',
    contractType: '',
    location:     '',
    city:         '',
    country:      '',
    street:       '',
    description:  '',
    salary:       '',
    startDate:    '',
    duration:     '',
  };

  // ── Helper ──────────────────────────────────────────────
  function text(selector, root) {
    return (root || document).querySelector(selector)?.textContent?.trim() || '';
  }
  function attr(selector, attribute, root) {
    return (root || document).querySelector(selector)?.getAttribute(attribute)?.trim() || '';
  }

  // ── LinkedIn ─────────────────────────────────────────────
  if (url.includes('linkedin.com')) {
    data.title = (
      text('.top-card-layout__title') ||
      text('h1.t-24') ||
      text('h1.jobs-unified-top-card__job-title') ||
      text('h1')
    );
    data.company = (
      text('.topcard__org-name-link') ||
      text('.jobs-unified-top-card__company-name a') ||
      text('.topcard__flavor:first-child')
    );
    data.location = (
      text('.topcard__flavor--bullet') ||
      text('.jobs-unified-top-card__bullet')
    );
    document.querySelectorAll('.description__job-criteria-item').forEach((item) => {
      const header = text('.description__job-criteria-subheader', item);
      const value  = text('.description__job-criteria-text',      item);
      if (/type de contrat|employment type/i.test(header)) data.contractType = value;
      if (/lieu|location/i.test(header) && !data.location)  data.location     = value;
    });
    data.description = (
      document.querySelector('.description__text')?.innerText ||
      document.querySelector('#job-details')?.innerText || ''
    ).trim().slice(0, 2000);
  }

  // ── Indeed ───────────────────────────────────────────────
  else if (url.includes('indeed.') || url.includes('emploi.francetravail')) {
    data.title = (
      text('h1.jobsearch-JobInfoHeader-title') ||
      text('h1[data-testid="jobsearch-JobInfoHeader-title"]') ||
      text('h1')
    );
    data.company = (
      text('[data-testid="inlineHeader-companyName"] a') ||
      text('.jobsearch-InlineCompanyRating-companyHeader a') ||
      attr('[data-company-name]', 'data-company-name')
    );
    data.location = text('[data-testid="job-location"]');
    document.querySelectorAll('.js-match-insights-provider, [class*="jobInfoItem"]').forEach((el) => {
      const t = el.textContent.trim();
      if (/CDI|CDD|stage|alternance|apprentissage/i.test(t) && !data.contractType) {
        data.contractType = t.split('\n')[0].trim();
      }
    });
    data.description = (document.querySelector('#jobDescriptionText')?.innerText || '').trim().slice(0, 2000);
  }

  // ── Welcome to the Jungle ────────────────────────────────
  else if (url.includes('welcometothejungle.com')) {
    data.title = (
      text('[data-testid="job-header-title"]') ||
      text('h1')
    );
    data.company = (
      text('[data-testid="company-title"]') ||
      text('a[href*="/companies/"]')
    );
    document.querySelectorAll('[data-testid*="contract-type"], [class*="contract"]').forEach((el) => {
      if (!data.contractType) data.contractType = el.textContent.trim();
    });
    document.querySelectorAll('[data-testid*="location"], [class*="location"]').forEach((el) => {
      if (!data.location) data.location = el.textContent.trim();
    });
  }

  // ── HelloWork ────────────────────────────────────────────
  else if (url.includes('hellowork.com')) {
    data.title = (
      text('h1.job-title') ||
      text('h1[itemprop="title"]') ||
      text('h1')
    );
    data.company = (
      text('[itemprop="hiringOrganization"] [itemprop="name"]') ||
      text('.company-name, .company-title')
    );
    data.location = text('[itemprop="jobLocation"] [itemprop="name"], .location');
    document.querySelectorAll('.tags-list .tag, [class*="contract"]').forEach((el) => {
      const t = el.textContent.trim();
      if (/CDI|CDD|stage|alternance|freelance|intérim/i.test(t) && !data.contractType) {
        data.contractType = t;
      }
    });
  }

  // ── APEC ─────────────────────────────────────────────────
  else if (url.includes('apec.fr')) {
    data.title = (
      text('h1.title-offer') ||
      text('.job-detail-title h1') ||
      text('h1')
    );
    data.company = (
      text('.company-label') ||
      text('[class*="company-name"]') ||
      text('.offre-company-name')
    );
    data.location = text('.lieu-offre, [class*="location"]');
    document.querySelectorAll('.key-element, .item-type-offre').forEach((el) => {
      const t = el.textContent.trim();
      if (/CDI|CDD|stage|alternance/i.test(t) && !data.contractType) data.contractType = t;
    });
  }

  // ── France Travail / Pôle Emploi ─────────────────────────
  else if (url.includes('francetravail.fr') || url.includes('pole-emploi.fr')) {
    data.title   = text('h1.title, h1.title-offre') || text('h1');
    data.company = text('[class*="entreprise"] .name, .entreprise-denomination');
    data.location = text('[class*="location"], .lieu-travail');
    document.querySelectorAll('[class*="contrat"], [class*="contract-type"]').forEach((el) => {
      if (!data.contractType) data.contractType = el.textContent.trim();
    });
  }

  // ── Cadremploi ───────────────────────────────────────────
  else if (url.includes('cadremploi.fr')) {
    data.title    = text('h1.job-title') || text('h1');
    data.company  = text('.company-name, [class*="company"] h2');
    data.location = text('.job-location, [class*="location"]');
    document.querySelectorAll('.tag-list .tag, [class*="contract-type"]').forEach((el) => {
      const t = el.textContent.trim();
      if (/CDI|CDD|stage|alternance|freelance/i.test(t) && !data.contractType) data.contractType = t;
    });
  }

  // ── JobTeaser ────────────────────────────────────────────
  else if (url.includes('jobteaser.com')) {
    data.title    = text('[data-testid="job-title"], h1');
    data.company  = text('[data-testid="company-name"], .company-name');
    data.location = text('[data-testid="job-location"], [class*="location"]');
    document.querySelectorAll('[data-testid="contract-type"], [class*="contract"]').forEach((el) => {
      if (!data.contractType) data.contractType = el.textContent.trim();
    });
  }

  // ── Monster / Meteojob / generic ─────────────────────────
  // (falls through to JSON-LD block below)

  // ── JSON-LD structured data (works on most compliant sites) ──
  if (!data.title || !data.company) {
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const items = [].concat(JSON.parse(script.textContent));
        for (const item of items) {
          const job = item['@type'] === 'JobPosting' ? item : null;
          if (!job) continue;
          if (!data.title        && job.title)                                       data.title        = job.title;
          if (!data.company      && job.hiringOrganization?.name)                    data.company      = job.hiringOrganization.name;
          if (!data.contractType && job.employmentType)                              data.contractType = [].concat(job.employmentType).join(' ');
          if (!data.location     && job.jobLocation?.address?.addressLocality)       data.location     = job.jobLocation.address.addressLocality;
          if (!data.salary       && job.baseSalary?.value?.value)                   data.salary       = `${job.baseSalary.value.value} ${job.baseSalary.currency || ''}`;
          if (!data.startDate    && job.validThrough)                                data.startDate    = job.validThrough;
          if (!data.description  && job.description)                                 data.description  = job.description.replace(/<[^>]*>/g, ' ').trim().slice(0, 2000);
        }
      } catch (_) {}
    }
  }

  // ── Last-resort generic extraction ──────────────────────
  if (!data.title) {
    data.title = (
      attr('meta[property="og:title"]', 'content') ||
      text('h1')
    );
  }
  if (!data.company) {
    data.company = attr('meta[property="og:site_name"]', 'content');
  }

  // Try to infer contract type from body text if still missing
  if (!data.contractType) {
    const patterns = [
      { re: /\b(alternance|alternant|apprentissage|apprenti)\b/i,         label: 'Alternance' },
      { re: /\b(stage|stagiaire)\b/i,                                      label: 'Stage' },
      { re: /\bCDI\b/,                                                     label: 'CDI' },
      { re: /\bCDD\b/,                                                     label: 'CDD' },
      { re: /\bfree[-\s]?lance\b/i,                                        label: 'Freelance' },
      { re: /\b(VIE|V\.I\.E)\b/,                                           label: 'VIE' },
      { re: /\bintérim\b/i,                                                label: 'Intérim' },
    ];
    for (const { re, label } of patterns) {
      if (re.test(body)) { data.contractType = label; break; }
    }
  }

  // Normalise whitespace on all string fields
  for (const key of Object.keys(data)) {
    if (typeof data[key] === 'string') {
      data[key] = data[key].replace(/\s+/g, ' ').trim();
    }
  }

  // ── Parse city & country from location ────────────────────────────────
  if (data.location && !data.city) {
    // Remove remote/hybrid indicators first
    const loc = data.location.replace(/\b(remote|télétravail|hybride|hybrid|on.?site|présentiel)\b/gi, '').trim();

    // Split on comma, dash, ·, pipe — first part = city, last = country
    const parts = loc.split(/[,\u00b7|\-]/).map(p => p.trim()).filter(Boolean);

    if (parts.length >= 2) {
      const last = parts[parts.length - 1];
      // Heuristic: if last part looks like a country name keep it, else it's a region
      const knownCountries = /france|belgique|suisse|luxembourg|allemagne|espagne|italie|royaume.uni|united kingdom|pays.bas|canada|maroc|tunisie|sénégal/i;
      data.city    = parts[0];
      data.country = knownCountries.test(last) ? last : 'France';
    } else if (parts.length === 1) {
      data.city    = parts[0];
      data.country = 'France';
    }
  }

  // Default country to France if still empty
  if (!data.country) data.country = 'France';

  return data;
}
