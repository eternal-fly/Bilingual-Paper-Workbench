import {isLanguage} from './languages.mjs';

/** A revision above zero records an explicit project preference. Legacy zh-CN
 * at revision zero was the old default, not evidence of an author choice. */
export function resolveInterfacePreference(preferences,{explicitLanguage,storedLanguage,cookieLanguage,currentLanguage='en'}={}){
  if(Number.isSafeInteger(preferences?.revision)&&preferences.revision>0&&isLanguage(preferences.uiLanguage))return preferences.uiLanguage;
  if(isLanguage(explicitLanguage))return explicitLanguage;
  for(const value of [cookieLanguage,storedLanguage])if(isLanguage(value)&&value!=='zh-CN')return value;
  if(isLanguage(preferences?.uiLanguage)&&preferences.uiLanguage!=='zh-CN')return preferences.uiLanguage;
  return isLanguage(currentLanguage)&&currentLanguage!=='zh-CN'?currentLanguage:'en';
}
