'use strict';

/**
 * Category settings (config key `categories`):
 *
 *   {
 *     "fromUp": true,                 // mirror Up's categories onto imported purchases
 *     "transfers": {                  // category for the on-budget half of a transfer
 *       "<off-budget Actual account id>": "Contributions",
 *       "<another off-budget account id>": "Pocket Money"
 *     }
 *   }
 *
 * Up categories are mirrored by name: Up's parent category becomes an
 * Actual category group (Home, Personal, Good Life, Transport) and the
 * category is created inside it the first time it is used. Transfer
 * categories are looked up by name and must already exist.
 */

const lower = (s) => String(s || '').trim().toLowerCase();

/**
 * @param {object} api - @actual-app/api with a budget open
 * @param {object} opts
 * @param {Array} opts.upCategories - Up /categories resources
 * @param {Iterable<string>} opts.usedUpIds - Up category ids that need an Actual category
 * @param {object} [opts.settings] - the `categories` config
 * @returns {Promise<{ byUp: Map<string,string>, transfer: Map<string,string>, created: string[], warnings: string[] }>}
 */
async function resolveCategories(api, { upCategories = [], usedUpIds = [], settings = {} }) {
  const out = { byUp: new Map(), transfer: new Map(), created: [], warnings: [] };
  const wantUp = settings.fromUp ? [...new Set(usedUpIds)].filter(Boolean) : [];
  const transfers = Object.entries(settings.transfers || {});
  if (!wantUp.length && !transfers.length) return out;

  const groups = await api.getCategoryGroups();
  const categories = await api.getCategories();
  const upById = new Map(upCategories.map((c) => [c.id, c]));

  for (const upId of wantUp) {
    const up = upById.get(upId);
    if (!up) continue;
    const parentId = up.relationships?.parent?.data?.id;
    const groupName = parentId ? upById.get(parentId)?.attributes?.name || 'Up' : up.attributes.name;
    let group = groups.find((g) => !g.is_income && lower(g.name) === lower(groupName));
    if (!group) {
      group = { id: await api.createCategoryGroup({ name: groupName }), name: groupName, is_income: false };
      groups.push(group);
      out.created.push(groupName);
    }
    let cat = categories.find((c) => c.group_id === group.id && lower(c.name) === lower(up.attributes.name));
    if (!cat) {
      cat = { id: await api.createCategory({ name: up.attributes.name, group_id: group.id }), name: up.attributes.name, group_id: group.id };
      categories.push(cat);
      out.created.push(`${groupName} › ${up.attributes.name}`);
    }
    out.byUp.set(upId, cat.id);
  }

  for (const [accountId, name] of transfers) {
    const matches = categories.filter((c) => lower(c.name) === lower(name) && !c.hidden);
    if (matches.length === 1) out.transfer.set(accountId, matches[0].id);
    else out.warnings.push(matches.length ? `Category "${name}" is ambiguous` : `Category "${name}" not found in Actual`);
  }
  return out;
}

/** Up category ids used by a set of importer entries. */
function usedUpCategoryIds(entries) {
  return entries.flatMap((e) => e.txns.map((t) => t.relationships?.category?.data?.id)).filter(Boolean);
}

/** Fetch Up's category list only when it will be used. */
async function fetchUpCategories(upClient, token, settings) {
  return settings?.fromUp ? upClient.getCategories(token) : [];
}

/** resolveCategories for importer entries, logging any warnings. */
async function forEntries(api, entries, upCategories, settings) {
  const res = await resolveCategories(api, { upCategories, usedUpIds: usedUpCategoryIds(entries), settings });
  if (res.created.length) console.log(`Created categories: ${res.created.join(', ')}`);
  for (const w of res.warnings) console.warn(`Categories: ${w}`);
  return res;
}

module.exports = { resolveCategories, usedUpCategoryIds, fetchUpCategories, forEntries };
