import { CORE_LANGUAGE_PACKS } from './language-packs.mjs';
import { CONNECTION_ENGLISH } from './connection-copy.mjs';
/** Shared, stable BCP 47 choices. Language names remain readable in their own script. */
export const COMMON_LANGUAGES = Object.freeze([
  ['zh-CN', '简体中文'], ['zh-TW', '繁體中文'], ['en', 'English'], ['ja', '日本語'], ['ko', '한국어'],
  ['fr', 'Français'], ['de', 'Deutsch'], ['es', 'Español'], ['pt', 'Português'], ['it', 'Italiano'],
  ['ru', 'Русский'], ['ar', 'العربية'], ['hi', 'हिन्दी'], ['bn', 'বাংলা'], ['ur', 'اردو'],
  ['id', 'Bahasa Indonesia'], ['ms', 'Bahasa Melayu'], ['th', 'ไทย'], ['vi', 'Tiếng Việt'], ['tr', 'Türkçe'],
  ['pl', 'Polski'], ['nl', 'Nederlands'], ['sv', 'Svenska'], ['da', 'Dansk'], ['no', 'Norsk'], ['fi', 'Suomi'],
  ['el', 'Ελληνικά'], ['he', 'עברית'], ['uk', 'Українська'], ['cs', 'Čeština'], ['ro', 'Română'], ['hu', 'Magyar'],
  ['fa', 'فارسی'], ['ta', 'தமிழ்'], ['te', 'తెలుగు'], ['mr', 'मराठी'], ['fil', 'Filipino'], ['sw', 'Kiswahili'],
  ['sk', 'Slovenčina'], ['bg', 'Български'], ['hr', 'Hrvatski'], ['sr', 'Српски'], ['ca', 'Català'], ['et', 'Eesti'], ['lt', 'Lietuvių'], ['lv', 'Latviešu']
].map(([code, nativeName]) => Object.freeze({ code, nativeName })));
export const languageNames = Object.fromEntries(COMMON_LANGUAGES.map(item => [item.code, item.nativeName]));
export const isLanguage = value => COMMON_LANGUAGES.some(item => item.code === value);
export const resolveTargetLanguage = (choice, uiLanguage = 'en') => choice === 'interface' ? uiLanguage : isLanguage(choice) ? choice : 'zh-CN';
export const isRtlLanguage = language => /^(ar|he|fa|ur)(-|$)/.test(language);

// UI copy only. Manuscript text, imported feedback, paths, and chat messages are never translated here.
const english = {
  '双语论文修订':'Bilingual Paper Editor','跳至译文编辑':'Skip to translation editor','文稿工具':'Manuscript tools','项目':'Project','打开项目':'Open project','历史':'History','打开论文任务历史':'Open paper task history','论文任务与历史':'Paper tasks & history','目录':'Outline','展开或收起文稿目录':'Toggle document outline','语言':'Language','译文语言':'Translation language','界面语言':'Interface language','跟随界面语言':'Follow interface language','选择译文语言':'Choose languages','主题':'Theme','界面主题':'Interface theme','浅色':'Light','深色':'Dark','更新':'Refresh','检查外部修改':'Check external changes','意见':'Notes','展开或收起段落意见':'Toggle paragraph notes','修订':'Revisions','打开修订队列':'Open revision queue','同步':'Sync','打开双语同步设置':'Open bilingual sync settings','双语同步设置':'Bilingual sync settings','翻译':'Translate','翻译选段':'Translate selection','讨论':'Discuss','与项目 Codex 讨论选段':'Discuss selection with Codex','建议':'Suggest','生成原文建议':'Suggest source revision','拆分':'Split','拆分译文':'Split translation','更多':'More','更多工作区选项':'More workspace options','选段与结果':'Selection & results','关联选段':'Link selection','导入结果':'Import result','尚未选择主文件':'No main file selected','正在检测宿主':'Detecting host','原文':'Source','译文':'Translation','审查':'Review','论文章节':'Paper sections','文稿目录':'Document outline','原文保持不变':'Source unchanged','译稿、提案与原文分别保存。':'Translations, proposals, and source are saved separately.','英文原稿':'English source','版本与编译依据':'Version & build details','文本':'Text','日志':'Log','查看编译日志':'View build log','定位':'Locate','在 PDF 中定位当前段落':'Locate selected paragraph in PDF','详情':'Details','模型读取目标':'Model PDF target','原版与最新版':'Original & latest','当前打开的 PDF':'Currently open PDF','冻结原版':'Frozen original','最新版英文':'Latest English','构建与定位':'Build & location','等待编译能力':'Waiting for compiler','未载入版本':'No snapshot loaded','显示 LaTeX':'Show LaTeX','显示的构建版本':'Displayed build','显示的 PDF 构建':'Displayed PDF build','选择 PDF 构建':'Select PDF build','生成英文 PDF':'Build English PDF','取消':'Cancel','英文原稿 PDF 页面':'English source PDF pages','生成英文阅读稿':'Build English reading PDF','读取英文 PDF':'Load English PDF','上一页':'Previous','下一页':'Next','PDF 上一页':'Previous PDF page','PDF 下一页':'Next PDF page','PDF 缩放':'PDF zoom','定位选段':'Locate selection','译文编辑':'Translation editor','原稿与原翻译独立保留':'Original source & translation retained','审阅方式':'Review view','对照':'Compare','选择段落后生成译文或讨论':'Select a paragraph to translate or discuss','段落批注':'Paragraph comments','调整对齐':'Align paragraphs','原稿':'Original source','原翻译':'Original translation','原始版本 · 只读':'Original version · read only','原始译文 · 只读':'Original translation · read only','写作建议':'Writing suggestions','尚无建议':'No suggestions','最终修改':'Final revision','尚未写回':'Not applied','编辑最终修改':'Edit final revision','编译并审查':'Compile & review','打开修订审查':'Open revision review','尚未选段':'No paragraph selected','译文编辑不会改变原文。':'Editing the translation does not change the source.','段落意见':'Paragraph notes','选择中间的译文段落':'Select a paragraph in the translation','收起':'Close','收起段落意见':'Close paragraph notes','导入审稿文件':'Import review file','Codex 审阅':'Codex review','Codex 评阅本段':'Review paragraph','显示意见范围':'Note scope','当前段落':'Selected paragraph','未定位意见':'Unlocated notes','全部意见':'All notes','停止全文审查':'Stop paper review','意见不会自动接受或写回原稿。':'Notes require explicit approval before changing the source.','添加人工批注':'Add comment','打开论文聊天':'Open paper chat','修订审查':'Revision review','先比较，再决定':'Compare before applying','正式写回未启用':'Source apply unavailable','收起修订审查':'Close revision review','勾选提案可合并审查':'Select proposals to review together','预览所选':'Preview selected','拒绝所选':'Reject selected','修订提案':'Revision proposals','请选择待审提案':'Select a proposal','编译候选预览':'Compile candidate preview','查看候选 PDF':'View candidate PDF','编辑建议':'Edit suggestion','提案批注':'Proposal comments','导出补丁':'Export patch','接受并写回':'Approve & apply','创建撤销提案':'Create undo proposal','拒绝提案':'Reject proposal','关闭':'Close','关闭 Codex 聊天面板':'Close Codex chat','调整 Codex 聊天宽度':'Resize Codex chat','收起 Codex 聊天':'Close Codex chat','释放聊天连接':'Disconnect chat','模型与线程':'Model & thread','模型':'Model','Codex 模型':'Codex model','推理强度':'Reasoning effort','Codex 推理强度':'Codex reasoning effort','模型默认':'Model default','连接论文聊天':'Connect paper chat','固定线程':'Pinned thread','尚未连接':'Not connected','让讨论留在文稿旁':'Discuss beside the paper','论文反馈':'Paper feedback','发送给 Codex 的消息':'Message Codex','仅发送输入的消息与明确选择的内容':'Sends your message and explicitly selected context','停止':'Stop','发送':'Send','本地后端':'Local backend','导出未保存草稿':'Export unsaved drafts','主 .tex 文件':'Main .tex file','项目目录':'Project directory','源语言':'Source language','目标语言':'Target language','打开':'Open','打开项目，保留每一处修改的来由':'Open a project to begin editing','合成示例':'Synthetic example','选择主文件':'Choose main file','导入审稿意见':'Import review notes','意见文件':'Review file','解析并导入意见':'Parse & import notes','审阅范围':'Review scope','审阅全文':'Entire paper','当前选段':'Selected paragraphs','生成对应语言译稿':'Generate target-language translation','开始审阅':'Start review','评阅 PDF':'PDFs to review','附加要求（可选）':'Additional instructions (optional)','使用当前聊天项目':'Use current chat project','刷新记录':'Refresh history','当前任务':'Current task','当前聊天目录':'Current chat directory','界面翻译暂以英语显示；译文与意见仍使用所选目标语言。':'Interface translation falls back to English; manuscript translation and notes use your chosen target language.'
};
const traditional = {'双语论文修订':'雙語論文修訂','项目':'專案','打开项目':'開啟專案','历史':'歷史','论文任务与历史':'論文任務與歷史','目录':'目錄','语言':'語言','译文语言':'譯文語言','界面语言':'介面語言','跟随界面语言':'跟隨介面語言','主题':'主題','浅色':'淺色','深色':'深色','更新':'更新','意见':'意見','修订':'修訂','同步':'同步','翻译':'翻譯','讨论':'討論','建议':'建議','拆分':'拆分','更多':'更多','原文':'原文','译文':'譯文','审查':'審查','译文编辑':'譯文編輯','原稿与原翻译独立保留':'原稿與原翻譯獨立保留','段落意见':'段落意見','选择中间的译文段落':'選擇中間的譯文段落','导入审稿文件':'匯入審稿檔案','Codex 审阅':'Codex 審閱','Codex 评阅本段':'Codex 評閱本段','全部意见':'全部意見','当前段落':'目前段落','未定位意见':'未定位意見','模型读取目标':'模型讀取目標','原版与最新版':'原版與最新版','当前打开的 PDF':'目前開啟的 PDF','冻结原版':'凍結原版','最新版英文':'最新版英文','生成英文 PDF':'產生英文 PDF','选择 PDF 构建':'選擇 PDF 建置','收起':'收起','详情':'詳情','关闭':'關閉','发送':'傳送','取消':'取消','修订审查':'修訂審查','使用当前聊天项目':'使用目前聊天專案','刷新记录':'重新整理記錄','当前任务':'目前任務','界面翻译暂以英语显示；译文与意见仍使用所选目标语言。':'介面翻譯暫以英語顯示；譯文與意見仍使用所選目標語言。'};
Object.assign(english, {
 '匹配需核对的审稿意见':'Match review paragraphs','Codex 根据当前源码核对未定位或已变化的意见。原有链接保留，只有明确原文依据或你的确认才会更新关联；已写回意见默认跳过。':'Codex checks unlocated or changed opinions against the current source. Existing links remain until exact evidence or your confirmation updates them. Applied opinions are skipped by default.','本次交给 Codex 的需核对意见':'Opinions to recheck with Codex','尚未选择段落；请明确勾选需要关联的候选。':'No paragraphs selected. Explicitly choose the candidates to associate.','每行一对“中文 = English”，数量不限，完整 JSON 最多 8 KiB。保存设置后用于后续同步。':'One source = target pair per line, with no row-count limit and an 8 KiB total JSON budget. Save to use these terms in future synchronization.',
 '重新编译已确认英文':'Recompile confirmed English','确认精确候选并写回':'Confirm the exact candidate and apply','此次确认只适用于下列候选与构建。':'This confirmation applies only to the candidate and build shown below.','我已检查原文前后变化与候选预览，并确认这些修改符合我的写作意图。':'I have reviewed the source changes and candidate PDF and confirm they match my writing intent.','确认写回这份候选':'Apply this exact candidate','返回审查':'Back to review',
  '源码':'Source files','查看项目 LaTeX 源码':'Inspect project LaTeX source','项目 LaTeX 源码':'Project LaTeX source','项目文件':'Project file','选择项目源文件':'Choose project source file','完整项目源码，只读':'Complete project source, read only','英文 PDF 沿用项目主文件、模板、图表和参考文献格式。这里只读查看完整源码。':'The English PDF uses the project main file, template, figures and bibliography style. The complete source is read only here.',
  '更新译文':'Update translation','翻译变更或尚未翻译的段落':'Translate changed or untranslated paragraphs','更新对应段落的译文':'Update corresponding translations','选择确切源段落后预览翻译请求。仅更新选段译文，英文源码不变。':'Choose exact source paragraphs and preview the translation request. Only selected translations are updated; English source is unchanged.','范围':'Scope','预览选段翻译请求':'Preview translation request',
  '按原模板编译':'Compile original template','LaTeX 原模板 · 保留双栏、图表与引用':'Original LaTeX template · columns, figures and citations retained','按项目主 .tex 的原模板编译，保留 documentclass、双栏、图表与参考文献样式。源文件不会改变。':'Compile the main .tex with its original documentclass, columns, figures and bibliography style. Source files remain unchanged.',
  'Codex 整理':'Organize with Codex','Codex 整理导入意见':'Organize imported reviews with Codex','保留导入原文、处理决定和文件来源；整理结果显示在原意见旁，不自动修改论文或译稿。':'Keep imported text, decisions and file provenance. Organized results accompany the original opinions and do not change the paper or translation drafts.','需要整理的原始意见（可多选）':'Original opinions to organize (multiple selection)','整理要求（可选）':'Organization instructions (optional)','请求预览':'Request preview','准备整理请求':'Prepare organization request','复制请求':'Copy request','发送至已绑定聊天':'Send to bound chat','发送至论文专用 Codex':'Send to paper Codex chat','发送至当前原生聊天':'Send to current native chat','先连接论文聊天，或复制请求':'Connect paper chat or copy request','手动导入此整理请求的 JSON 结果':'Import this request result as JSON','此整理请求的 JSON 结果':'JSON result for this organization request','校验并回填整理结果':'Validate and return organized opinions',
  '原稿与最新稿审阅':'Paper PDF review','读取所选 PDF，按你的要求返回意见与译稿。':'Read selected PDFs and return the notes and translations you request.','读取哪份 PDF':'PDFs to read','全文':'Entire paper','同时生成所选语言译稿':'Also generate target-language translations','你的要求（可选）':'Your instructions (optional)','意见进入右栏，最新版译稿进入中栏。原版与待审候选仅生成意见；源文候选仍需单独审查。':'Notes appear in the right pane; latest-source translations appear in the middle. Original and candidate PDFs produce notes only. Source candidates require separate review.',
  '支持 TXT、Markdown、JSON、PDF 和 DOCX。文件内容作为意见资料读取。':'Supports TXT, Markdown, JSON, PDF and DOCX. File content is treated as review evidence.','保留文件来源；只能唯一匹配的原文才会自动定位。':'File provenance is retained. Notes are linked automatically only when their source match is unique.','当前 PDF 加载后会与论文聊天同步。':'The verified PDF view will be shared with the paper chat.','重新准备 PDF 全文':'Retry PDF text preparation','模型能力与可用性由当前 Codex 服务确认。':'The connected Codex service confirms model availability and capabilities.','独立面板使用 Codex 的持久线程；不自动读取其他聊天。':'The independent panel uses a persistent Codex thread. Other chats are read only when explicitly requested.','连接此文稿的固定聊天':'Connect the chat pinned to this paper','选择模型并连接固定线程后，可以讨论选段、翻译和写作建议。修改仍需在审查区确认。':'Choose a model and connect the paper thread to discuss paragraphs, translations, and writing. Source changes still require review.','读取原稿与最新英文稿；关闭后为普通对话。':'Reads the selected paper PDFs; turn off for ordinary chat.','打开 LaTeX 项目':'Open LaTeX project','当前双语论文已用 XeLaTeX 验证。pdfLaTeX 适用于与它兼容的项目；不支持 fontspec 或 xeCJK。':'XeLaTeX supports this bilingual workflow. Use pdfLaTeX for compatible projects without fontspec or xeCJK.','给 Codex 的说明':'Instructions for Codex','导入模型 JSON 结果':'Import model JSON result','JSON 结果':'JSON result','本窗口没有自动连接项目聊天。请把已登记请求复制到项目 Codex，再把返回的 JSON 粘贴到这里。后端会核对请求、选段、版本与保护对象；导入只形成译稿或待审提案，不写原文。':'Copy the registered request to your project chat, then paste its JSON response here. The backend validates request identity, paragraph scope, source version, and protected objects. Import creates a draft or a proposal for review.',
  '按聊天任务保存项目绑定、译稿和修订记录。':'Keep project bindings, translations, and revision records with their task.','暂无以往论文任务。首次打开后，项目与修订索引会保存在本机。':'No earlier paper tasks. Opening a paper creates a local project and revision index.','正在读取本机任务索引…':'Loading the local task index…','关闭论文任务历史':'Close paper task history','打开此论文任务':'Open paper task','重新打开此任务':'Reopen this task','段落':'Paragraph','尚未保存':'Unsaved','正在保存':'Saving','已保存':'Saved','保存失败':'Save failed','重试保存':'Retry save','导出草稿':'Export draft','译文已改，原文未改。':'Translation edited; source unchanged.','译文是独立派生稿，原文保持不变。':'Translation is saved independently; source unchanged.','只读结构':'Read-only structure','文档结构无需翻译；原始内容可展开查看。':'This document structure needs no translation. Expand it to inspect the original.','当前宿主尚未提供 PDF 目标同步。':'This host does not provide PDF target synchronization yet.','原文文本':'Source text','原版 PDF':'Original PDF','待审候选 PDF':'Candidate PDF','完整源 PDF':'Full source PDF','本地后端 · Codex 已连接':'Local backend · Codex connected','已持久化的草稿可在重开后恢复':'Saved drafts will be restored when you reopen the task','界面翻译暂以英语显示；译文与意见仍使用所选目标语言。':'Core controls use your interface language. Some help and diagnostics use English; translations and notes use the chosen target language.'
});
Object.assign(english,CONNECTION_ENGLISH,{'双语论文修订':'Bilingual Paper Workbench','打开项目，保留每一处修改的来由':'Open a project and keep each revision traceable.'});
Object.assign(english,{
 '编译完成':'Compilation complete','隔离编译已就绪 · 正式写回未启用':'Isolated compiler ready · Source promotion unavailable','审稿意见保留来源，处理状态与源文修改分别记录。':'Review notes retain their provenance. Decisions and source changes are tracked separately.',
 '待审候选':'Candidate','历史构建':'Historical build','当前 PDF 加载后会与论文聊天同步。':'The current PDF will be linked to the paper chat after loading.','正在本机准备 PDF 全文':'Preparing PDF text locally','PDF 全文已就绪':'PDF text ready','全文尚未就绪':'PDF text not ready',
 '原版（冻结）':'Original (frozen)','尚无英文 PDF':'No English PDF yet','待审候选（尚未写回）':'Candidate (not applied)','历史构建（技术）':'Historical build (technical)','隔离编译 · 受审写回':'Isolated compilation · Reviewed source promotion','自动编译与正式写回未启用':'Automatic compilation and source promotion unavailable','公式':'Formula','引用':'Citation','结构':'Structure','受保护对象':'Protected object',
 'Codex 审查意见':'Codex review','外部审稿意见':'External review','已处理':'Resolved','锚点待核对':'Verify anchor','未定位':'Unlocated','待处理':'Pending','待定':'Pending','采纳':'Adopt','再改':'Revise','保留':'Keep','原稿 / CURRENT':'CURRENT','整段建议 / RECOMMENDED':'RECOMMENDED PARAGRAPH','建议语句 / RECOMMENDED':'RECOMMENDED SENTENCE','修改理由':'REASON','棕色：原稿改动句':'Brown: changed source sentences','蓝色：建议改动句':'Blue: recommended sentences','未改句保持正文色':'Unchanged sentences use body text color','仅记录决定，原文未改。':'Decision recorded only; source unchanged.','定位段落':'Locate paragraph','关联当前段落':'Link selected paragraph','标记已处理':'Mark resolved','重新打开':'Reopen',
 '此段尚无意见':'No notes for this paragraph','没有未定位意见':'No unlocated notes','无法唯一匹配的意见会保留在这里，可由你明确指定段落。':'Notes without a unique match remain here until you assign their paragraphs.',
 '点击“Codex 评阅本段”可获取此段意见。导入审稿文件与全文审查的匹配意见也会显示在这里。':'Use “Review paragraph with Codex” to request notes. Matching imported and full-paper review notes also appear here.',
 'SyncTeX 精确定位：点击 PDF 关联原文，或定位当前选段。方向键与 Enter 也可选择 PDF 点。':'SyncTeX: click the PDF to locate its source, or locate the selected paragraph. Arrow keys and Enter can also select a PDF point.'
});
Object.assign(english, {
 '尚未选择论文项目':'No paper project selected',
 '在聊天中提供源码 ZIP 或项目目录，Codex 可导入你指定的论文与审稿意见。':'Provide a LaTeX source ZIP or project folder in the chat. Codex can import it with your selected review files, or you can open an existing project here.',
 '先导入论文项目，再连接该论文的 Codex 聊天。':'Import a paper project, then connect its Codex chat.',
 '等待选择论文':'Waiting for a paper project','打开论文项目后，可在这里讨论…':'Open a paper project to discuss it here…',
 '点击“生成英文 PDF”生成当前源的英文阅读稿。源文件不会改变。':'Build the English PDF from the current source. Source files remain unchanged.',
 '英文阅读稿尚未生成；隔离编译能力暂不可用。':'No English PDF yet. The isolated compiler is unavailable.',
 '后端未连接':'Backend disconnected','本机预览，手动传递请求':'Local preview · manual request transfer',
 '原生聊天数据通道已连接':'Native chat data channel connected','宿主桥已连接':'Host bridge connected',
 '当前聊天 · 原生 Codex':'Current chat · Native Codex','当前聊天 · 消息通道未就绪':'Current chat · Message channel unavailable',
 '独立窗口 · 绑定聊天已连接':'Independent window · Paper chat connected','独立窗口 · 等待聊天连接卡':'Independent window · Waiting for chat connection',
 '选择段落后生成译文或讨论':'Select a paragraph to translate or discuss.',
 '让修改有据可循':'Keep every revision traceable','先试用合成示例':'Try a synthetic example',
 '用熟悉的语言思考':'Write in your preferred language',
 '译文草稿独立保存。公式、引用与宏保留原样，模型建议进入审查队列。原文不会随输入自动改变。':'Translations are saved separately. Formulas, references and macros are protected. Model suggestions remain pending until reviewed; typing never changes the source.',
 '受保护对象（详见原文）':'Protected object (see source)'
});
Object.assign(english, {
 '独立面板 · 连接论文 Codex':'Workbench · Connect paper Codex',
 '四层对照':'Compare versions','正在提交本段…':'Submitting paragraph…',
 '正在保存译文草稿…':'Saving translation drafts…',
 '显式发送后，由调用插件的当前聊天读取论文并返回意见；不会另开模型线程。':'After an explicit request, the invoking chat reads the paper and returns feedback in the same conversation.',
 '独立面板使用明确连接的 Codex 线程；不自动读取其他聊天。':'This workbench uses the explicitly connected Codex thread. It does not automatically read other chats.',
 '发送至当前线程':'Send to current chat','发送至论文 Codex':'Send to paper Codex',
 '对齐关系经人工调整后，此单元尚未归入当前对齐组。请使用“调整对齐”明确指定。':'This unit is not assigned to the current alignment group. Use Align paragraphs to assign it explicitly.'
});
function englishDynamic(text){
 let match;
 if((match=/^(.+) · (\d+) 条意见需匹配当前段落。完整范围将在预览后明确发送；较大内容由后台分批处理。打开窗口不会调用模型。$/u.exec(text)))return `${match[1]} · ${match[2]} opinions need current paragraph matching. Preview and explicitly send the full scope; the backend batches larger content. Opening this window calls no model.`;
 if((match=/^单文件最多 (.+) MiB，提取文字最多 (.+) MiB，PDF 最多 (.+) 页；意见数量不限。$/u.exec(text)))return `Up to ${match[1]} MiB per file, ${match[2]} MiB extracted text and ${match[3]} PDF pages. No opinion-count limit.`;
 if((match=/^(\d+) 条意见尚未确定位置。先查看原始意见和候选段落，可选择多个段落共同关联；也可保留未定位。$/u.exec(text)))return `${match[1]} opinions need paragraph confirmation. Read the original concern and candidate paragraphs, then explicitly associate all relevant paragraphs or defer.`;
 if((match=/^段落批注(?: (\d+))?$/u.exec(text)))return `Paragraph comments${match[1] ? ` ${match[1]}` : ''}`;
 if((match=/^未定位意见（(\d+)）$/u.exec(text)))return `Unlocated (${match[1]})`;
 if((match=/^(\d+) 段保存失败，编辑缓冲仍保留$/u.exec(text)))return `${match[1]} paragraphs could not be saved; editing buffers retained`;
 if((match=/^(\d+) 段尚未保存$/u.exec(text)))return `${match[1]} unsaved paragraphs`;
 if((match=/^(.+) · 草稿独立保存$/u.exec(text))){const code=COMMON_LANGUAGES.find(item=>item.nativeName===match[1])?.code;const label=code?new Intl.DisplayNames(['en'],{type:'language'}).of(code):match[1];return `${label} · Independent drafts`;}
 if((match=/^(.+)；(译文编辑不会改变原文。|按明确对齐组定位。)$/u.exec(text)))return `${match[1]}; ${match[2] === '译文编辑不会改变原文。' ? 'Translation editing does not change source.' : 'Located through the explicit alignment group.'}`;
 if((match=/^已选(译文单元|原文段落)，尚未对齐$/u.exec(text)))return `Selected ${match[1] === '译文单元' ? 'translation unit' : 'source paragraph'}; not aligned`;
 if((match=/^当前打开：(.+) · (.+)$/u.exec(text)))return `Open PDF: ${uiText(match[1],'en')} · ${match[2]}`;
 if((match=/^源版本 (.+)$/u.exec(text)))return `Source snapshot ${match[1]}`;
 if((match=/^当前源的英文原稿构建 · (.+) · 源版本 (.+)$/u.exec(text)))return `English source build · ${match[1]} · Source snapshot ${match[2]}`;
 if((match=/^(\d+) 个阅读段落 · (.+) · 独立草稿$/u.exec(text))){const code=COMMON_LANGUAGES.find(item=>item.nativeName===match[2])?.code;const label=code?new Intl.DisplayNames(['en'],{type:'language'}).of(code):match[2];return `${match[1]} reading paragraphs · ${label} · Independent drafts`;}
 if((match=/^已选 (\d+) 个原文段落 ↔ (\d+) 个译文单元$/u.exec(text)))return `Selected ${match[1]} source paragraphs ↔ ${match[2]} translation units`;
 if((match=/^段落 (\d*) · (\d+) 个精确原文锚点$/u.exec(text)))return `Paragraph ${match[1]} · ${match[2]} exact source anchors`;
 if((match=/^段落 (\d+)$/u.exec(text)))return `Paragraph ${match[1]}`;
 if((match=/^(已验证连接|已保存绑定) · (.+)$/u.exec(text)))return `${uiText(match[1],'en')} · ${match[2]}`;
 return '';
}
export function uiText(text, language = 'en') { return language === 'zh-CN' ? text : language === 'zh-TW' ? traditional[text] || text : CORE_LANGUAGE_PACKS[language]?.[text] || english[text] || englishDynamic(text) || text; }
export const interfaceFallback = language => !['zh-CN', 'zh-TW', 'en'].includes(language);
export function populateLanguages(select, { follow = false, uiLanguage = 'en' } = {}) {
  const old = select.value;
  select.replaceChildren(...(follow ? [new Option(uiText('跟随界面语言', uiLanguage), 'interface')] : []), ...COMMON_LANGUAGES.map(({ code, nativeName }) => new Option(nativeName, code)));
  if ([...select.options].some(option => option.value === old)) select.value = old;
}
const originalCopy = new WeakMap();
const knownCopy = text => Object.hasOwn(english, text) || Object.hasOwn(traditional, text) || Object.values(CORE_LANGUAGE_PACKS).some(pack => Object.hasOwn(pack, text)) || Boolean(englishDynamic(text));
export function localizeInterface(root, language) {
  const excluded = '#source-content,#translation-content,#annotation-list,#proposal-list,#proposal-detail,#chat-messages,#workspace-record-list,#workspace-history-context,#main-file,#project-label,#acceptance-diff,#layer-original-source,#layer-original-translation,#layer-suggestions,#layer-final,pre,code,textarea,option';
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let current; (current = walker.nextNode());) {
    if (current.parentElement?.closest(excluded)) continue;
    const value = current.nodeValue.trim(); if (!value) continue;
    let original = originalCopy.get(current);
    if (!original || (current.nodeValue.trim() !== uiText(original, language) && knownCopy(value))) { original = value; originalCopy.set(current, original); }
    if (knownCopy(original)) current.nodeValue = current.nodeValue.replace(value, uiText(original, language));
  }
  for (const element of root.querySelectorAll('[aria-label],[title],[placeholder]')) {
    if (element.closest(excluded)) continue;
    for (const attribute of ['aria-label', 'title', 'placeholder']) {
      const value = element.getAttribute(attribute); if (!value) continue;
      const key = `i18n${attribute.replaceAll('-', '')}`; const original = element.dataset[key] || value; element.dataset[key] = original;
      if (knownCopy(original)) element.setAttribute(attribute, uiText(original, language));
    }
  }
}
