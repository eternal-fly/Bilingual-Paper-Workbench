export const RECOMMENDATION_FIELDS = Object.freeze(['suggestedSource', 'suggestedTranslation', 'reasonSource', 'reasonTranslation']);
export const CURRENT_RECOMMENDATION_FIELDS = Object.freeze(['currentSource', 'currentTranslation']);
export const PARAGRAPH_RECOMMENDATION_INSTRUCTION = 'Default each localized opinion to scope="paragraph": currentSource is the complete current source-language paragraph copied exactly from supplied evidence, and currentTranslation is its complete current target-language text copied exactly when supplied (otherwise a faithful translation of currentSource). suggestedSource and suggestedTranslation are the complete recommended paragraph and its faithful target-language translation, retaining all unchanged sentences and protected objects in order. Change only the sentences justified by this opinion. reasonSource and reasonTranslation explain those changes in both languages. If reliable whole-paragraph context is unavailable, use scope="sentence" or scope="note" and do not invent missing context. General advice alone is insufficient. Optional body/recommendation must equal reasonTranslation/suggestedTranslation. ';

/** New model generations must supply usable bilingual replacements/reasons.
 * Historical notes remain readable through the legacy normalizer.
 */
export function requireBilingualRecommendations(notes) {
  if (!Array.isArray(notes) || notes.some(note => !note || RECOMMENDATION_FIELDS.some(key => typeof note[key] !== 'string' || !note[key].trim()))) {
    throw Object.assign(new Error('Each new model opinion needs suggested source wording, its target-language translation, and a reason in both languages.'), { code: 'RECOMMENDATION_FORMAT_REQUIRED' });
  }
}
