// Public sample site seed data: a fully fictional real-estate company
// (ひだまり不動産株式会社). Every company, person, property, phone number,
// email and amount below is invented for demonstration. No real business or
// personal data. Staff/customer/property chains are internally consistent:
// customers -> deals -> contracts -> payments link by the numeric code
// fields (顧客コード / 物件コード / 商談コード / 契約コード).

export const COMPANY_NAME = 'ひだまり不動産株式会社';

export const STAFF = [
  { key: 'sato', name: '佐藤 葵' },
  { key: 'suzuki', name: '鈴木 健太' },
  { key: 'nakamura', name: '中村 翼' },
];

const opt = (value, label) => ({ value, label });

export const CUSTOMER_STATUS = [
  opt('mikomi', '見込み'), opt('sesshoku', '接触済'), opt('shodan', '商談中'),
  opt('annai', '案内済'), opt('moshikomi', '申込'), opt('seiyaku', '成約'), opt('shikkaku', '失客'),
];
export const PROPERTY_KIND = [
  opt('shinchiku', '新築戸建'), opt('mansion', 'マンション'), opt('chuko', '中古戸建'),
  opt('tochi', '土地'), opt('shueki', '収益物件'),
];
export const PROPERTY_STATE = [
  opt('hanbai', '販売中'), opt('zaiko', '在庫'), opt('shodan', '商談中'),
  opt('seiyaku', '成約済'), opt('shuryo', '販売終了'),
];
export const AREA = [
  opt('tenpaku', '天白区'), opt('showa', '昭和区'), opt('meito', '名東区'),
  opt('chikusa', '千種区'), opt('midori', '緑区'), opt('mizuho', '瑞穂区'),
];
export const LAYOUT = [
  opt('1r', '1R'), opt('1ldk', '1LDK'), opt('2ldk', '2LDK'), opt('3ldk', '3LDK'),
  opt('4ldk', '4LDK'), opt('5ldk', '5LDK以上'), opt('none', 'なし（土地）'),
];
export const FAMILY = [
  opt('single', '一人暮らし'), opt('couple', '夫婦'), opt('couple_kids', '夫婦＋子'),
  opt('parent_kids', '親＋子'), opt('other', 'その他'),
];
export const NEXT_ACTION = [
  opt('denwa', '電話連絡'), opt('teian', '物件提案'), opt('annai', '内見調整'),
  opt('joken', '条件提示'), opt('keiyaku', '契約手続'), opt('none', 'なし'),
];
export const PAY_TERMS = [opt('loan', 'ローン利用'), opt('cash', '現金一括'), opt('split', '分割')];
export const PAY_KIND = [opt('baikai', '売買代金'), opt('chukai', '仲介手数料'), opt('sonota', 'その他')];
export const PAY_STATUS = [opt('paid', '入金済'), opt('unpaid', '未入金'), opt('partial', '一部入金')];

// ---------------------------------------------------------------- customers
// [code, name, status, staffKey, budgetMin, budgetMax, firstContact]
const CUSTOMER_ROWS = [
  [1001, '田中健一', 'mikomi', 'sato', 2500, 3500, '2026-08-03'],
  [1002, '高橋由美', 'seiyaku', 'suzuki', 4000, 4800, '2026-08-12'],
  [1003, '佐藤美咲', 'shodan', 'nakamura', 3800, 4500, '2026-08-20'],
  [1004, '鈴木翔太', 'sesshoku', 'sato', 2000, 3000, '2026-09-02'],
  [1005, '渡辺葵', 'annai', 'suzuki', 2800, 3600, '2026-09-09'],
  [1006, '伊藤大輔', 'mikomi', 'nakamura', 5000, 6500, '2026-09-15'],
  [1007, '山本隆', 'moshikomi', 'sato', 3000, 3800, '2026-09-18'],
  [1008, '中村さくら', 'shodan', 'suzuki', 3200, 4000, '2026-09-25'],
  [1009, '小林誠', 'mikomi', 'nakamura', 1800, 2600, '2026-10-01'],
  [1010, '加藤陽菜', 'sesshoku', 'sato', 2600, 3400, '2026-10-06'],
  [1011, '吉田拓海', 'shodan', 'suzuki', 2400, 3200, '2026-10-11'],
  [1012, '山田花', 'mikomi', 'nakamura', 2200, 2900, '2026-10-16'],
  [1013, '井上直樹', 'annai', 'sato', 2900, 3700, '2026-10-21'],
  [1014, '松本梨乃', 'moshikomi', 'suzuki', 3600, 4400, '2026-10-25'],
  [1015, '木村蓮', 'seiyaku', 'nakamura', 4500, 5200, '2026-08-28'],
  [1016, '林美月', 'shodan', 'sato', 3100, 3900, '2026-11-02'],
  [1017, '清水颯', 'sesshoku', 'suzuki', 2700, 3300, '2026-11-08'],
  [1018, '森彩香', 'shikkaku', 'nakamura', 2300, 3100, '2026-08-08'],
];
const AREAS = [['tenpaku'], ['tenpaku', 'showa'], ['chikusa'], ['mizuho'], ['tenpaku'], ['meito'],
  ['meito'], ['midori'], ['midori'], ['showa'], ['chikusa', 'meito'], ['tenpaku'], ['mizuho'],
  ['showa'], ['tenpaku'], ['chikusa'], ['midori'], ['showa']];
const KIND_PREFS = [['shinchiku'], ['shinchiku'], ['chuko', 'shinchiku'], ['mansion'], ['mansion'],
  ['shueki'], ['mansion'], ['shinchiku'], ['tochi'], ['mansion', 'chuko'], ['chuko'], ['shinchiku'],
  ['mansion'], ['shinchiku'], ['shinchiku'], ['mansion'], ['chuko'], ['mansion']];
const LAYOUT_PREFS = ['3ldk', '4ldk', '4ldk', '2ldk', '3ldk', '5ldk', '3ldk', '3ldk', 'none',
  '2ldk', '3ldk', '3ldk', '3ldk', '4ldk', '4ldk', '3ldk', '3ldk', '2ldk'];
const FAMILIES = ['couple_kids', 'couple_kids', 'couple', 'single', 'couple', 'other', 'couple_kids',
  'parent_kids', 'single', 'single', 'couple', 'parent_kids', 'couple', 'couple_kids', 'couple',
  'single', 'single', 'couple'];

export const CUSTOMERS = CUSTOMER_ROWS.map(([code, name, status, staff, min, max, first], i) => ({
  code: String(code), name, status, staff: `staff:${staff}`,
  phone: `090-1000-${String(2001 + i)}`, email: `customer${code}@example.jp`,
  family: FAMILIES[i], budget_min: String(min), budget_max: String(max),
  area: JSON.stringify(AREAS[i]), kind_pref: JSON.stringify(KIND_PREFS[i]),
  layout_pref: LAYOUT_PREFS[i], first_contact: first,
  memo: i % 3 === 0 ? '初回ヒアリング済み。希望条件は概ね確定。' : '',
}));

// --------------------------------------------------------------- properties
// [code, name, location, kind, price, layout, land, building, built, state, staffKey]
const PROPERTY_ROWS = [
  [2001, '天白区戸建A', '名古屋市天白区平針1丁目', 'shinchiku', 3980, '4ldk', 132, 104, '2026-03-01', 'hanbai', 'sato'],
  [2002, '瑞穂区マンションB', '名古屋市瑞穂区瑞穂通3丁目', 'mansion', 3280, '3ldk', 0, 78, '2015-06-01', 'hanbai', 'suzuki'],
  [2003, '昭和区戸建C', '名古屋市昭和区川名町2丁目', 'chuko', 2680, '4ldk', 148, 112, '1998-04-01', 'zaiko', 'nakamura'],
  [2004, '緑区土地D', '名古屋市緑区大高町', 'tochi', 1980, 'none', 186, 0, '2020-01-01', 'hanbai', 'sato'],
  [2005, '天白区戸建E', '名古屋市天白区植田3丁目', 'shinchiku', 4580, '4ldk', 141, 118, '2026-05-01', 'seiyaku', 'suzuki'],
  [2006, '名東区マンションF', '名古屋市名東区藤が丘', 'mansion', 3480, '3ldk', 0, 82, '2018-09-01', 'shodan', 'sato'],
  [2007, '千種区戸建G', '名古屋市千種区星が丘元町', 'chuko', 4280, '5ldk', 176, 139, '2005-11-01', 'hanbai', 'nakamura'],
  [2008, '天白区マンションH', '名古屋市天白区原1丁目', 'mansion', 2980, '3ldk', 0, 71, '2012-02-01', 'zaiko', 'suzuki'],
  [2009, '昭和区土地I', '名古屋市昭和区滝川町', 'tochi', 1580, 'none', 121, 0, '2019-01-01', 'shuryo', 'sato'],
  [2010, '緑区戸建J', '名古屋市緑区鳴海町', 'shinchiku', 3780, '4ldk', 128, 101, '2026-07-01', 'hanbai', 'nakamura'],
  [2011, '瑞穂区収益K', '名古屋市瑞穂区洲山町', 'shueki', 5980, '5ldk', 203, 264, '2001-08-01', 'zaiko', 'sato'],
  [2012, '名東区戸建L', '名古屋市名東区一社2丁目', 'chuko', 3180, '4ldk', 139, 108, '2008-05-01', 'shodan', 'suzuki'],
  [2013, '千種区マンションM', '名古屋市千種区本山町4丁目', 'mansion', 3680, '3ldk', 0, 85, '2020-10-01', 'hanbai', 'nakamura'],
  [2014, '天白区戸建N', '名古屋市天白区野並2丁目', 'shinchiku', 4980, '5ldk', 158, 126, '2026-06-01', 'seiyaku', 'sato'],
  [2015, '昭和区マンションO', '名古屋市昭和区御器所3丁目', 'mansion', 2780, '2ldk', 0, 64, '2010-07-01', 'zaiko', 'suzuki'],
  [2016, '緑区戸建P', '名古屋市緑区桶狭間', 'shinchiku', 2880, '3ldk', 118, 96, '2025-12-01', 'hanbai', 'nakamura'],
  [2017, '名東区戸建Q', '名古屋市名東区牧の原3丁目', 'chuko', 2180, '3ldk', 124, 92, '1995-03-01', 'seiyaku', 'sato'],
  [2018, '瑞穂区戸建R', '名古屋市瑞穂区堀田通', 'shinchiku', 4180, '4ldk', 136, 109, '2026-08-01', 'shodan', 'suzuki'],
];
export const PROPERTIES = PROPERTY_ROWS.map(([code, name, location, kind, price, layout, land, building, built, state, staff]) => ({
  code: String(code), name, location, kind, price: String(price), layout,
  land_area: String(land), building_area: String(building), built, state, staff: `staff:${staff}`, note: '',
}));

// -------------------------------------------------------------------- deals
// [code, customerCode, propertyCode, targetState, staffKey, dealDate, nextAction, nextDate]
const DEAL_ROWS = [
  [4001, 1002, 2005, 'seiyaku', 'suzuki', '2026-08-20', 'keiyaku', '2026-09-05'],
  [4002, 1015, 2014, 'seiyaku', 'nakamura', '2026-09-03', 'keiyaku', '2026-09-18'],
  [4003, 1007, 2006, 'moshikomi', 'sato', '2026-09-25', 'keiyaku', '2026-11-28'],
  [4004, 1014, 2018, 'moshikomi', 'suzuki', '2026-10-30', 'keiyaku', '2026-11-27'],
  [4005, 1003, 2007, 'kosho', 'nakamura', '2026-09-01', 'joken', '2026-11-26'],
  [4006, 1008, 2010, 'kosho', 'suzuki', '2026-10-02', 'joken', '2026-11-25'],
  [4007, 1005, 2008, 'annai', 'suzuki', '2026-09-14', 'annai', '2026-11-26'],
  [4008, 1013, 2002, 'annai', 'sato', '2026-10-26', 'annai', '2026-11-29'],
  [4009, 1016, 2013, 'annai', 'sato', '2026-11-05', 'annai', '2026-11-28'],
  [4010, 1011, 2003, 'teian', 'suzuki', '2026-10-15', 'teian', '2026-11-27'],
  [4011, 1009, 2004, 'teian', 'nakamura', '2026-10-05', 'teian', '2026-11-26'],
  [4012, 1010, 2012, 'teian', 'sato', '2026-10-09', 'teian', '2026-11-30'],
  [4013, 1001, 2001, 'shosodan', 'sato', '2026-11-18', 'denwa', '2026-11-25'],
  [4014, 1006, 2011, 'shosodan', 'nakamura', '2026-11-12', 'denwa', '2026-11-27'],
  [4015, 1017, 2016, 'shosodan', 'suzuki', '2026-11-15', 'teian', '2026-11-28'],
  [4016, 1018, 2015, 'mikyaku', 'nakamura', '2026-08-15', 'none', '2026-09-01'],
];
export const DEALS = DEAL_ROWS.map(([code, customer, property, state, staff, date, next, nextDate]) => ({
  code: String(code), customer_key: String(customer), property_key: String(property),
  targetState: state, staff: `staff:${staff}`, deal_date: date, next_action: next, next_date: nextDate, memo: '',
}));

export const DEAL_STATES = [
  { code: 'shosodan', name: '初回相談', initial: true, terminal: false },
  { code: 'teian', name: '物件提案', initial: false, terminal: false },
  { code: 'annai', name: '内見案内', initial: false, terminal: false },
  { code: 'kosho', name: '条件交渉', initial: false, terminal: false },
  { code: 'moshikomi', name: '申込', initial: false, terminal: false },
  { code: 'seiyaku', name: '成約', initial: false, terminal: true },
  { code: 'mikyaku', name: '見送り', initial: false, terminal: true },
];
// [name, from, to]
export const DEAL_ACTIONS = [
  ['提案する', 'shosodan', 'teian'],
  ['案内する', 'teian', 'annai'],
  ['交渉を始める', 'annai', 'kosho'],
  ['申込を受ける', 'kosho', 'moshikomi'],
  ['申込を受ける', 'annai', 'moshikomi'],
  ['成約する', 'moshikomi', 'seiyaku'],
  ['見送りにする', 'shosodan', 'mikyaku'],
  ['見送りにする', 'teian', 'mikyaku'],
  ['見送りにする', 'annai', 'mikyaku'],
  ['見送りにする', 'kosho', 'mikyaku'],
  ['提案に戻す', 'annai', 'teian'],
];

// ---------------------------------------------------------------- contracts
// [code, customerCode, propertyCode, dealCode, targetState, date, amount, deposit, terms, staffKey]
const CONTRACT_ROWS = [
  [3001, 1002, 2005, 4001, 'hikiwatashi', '2026-09-12', 4580, 200, 'loan', 'suzuki'],
  [3002, 1015, 2014, 4002, 'hikiwatashi', '2026-09-26', 4980, 250, 'loan', 'nakamura'],
  [3003, 1007, 2006, 4003, 'keiyaku', '2026-11-14', 3480, 300, 'loan', 'sato'],
  [3004, 1014, 2018, 4004, 'loan', '2026-11-18', 4180, 200, 'loan', 'suzuki'],
  [3005, 1003, 2007, 4005, 'uketsuke', '2026-11-21', 4280, 0, 'cash', 'nakamura'],
];
export const CONTRACTS = CONTRACT_ROWS.map(([code, customer, property, deal, state, date, amount, deposit, terms, staff]) => ({
  code: String(code), customer_key: String(customer), property_key: String(property), deal_key: String(deal),
  targetState: state, contract_date: date, amount: String(amount), deposit: String(deposit),
  terms, staff: `staff:${staff}`, note: '',
}));

export const CONTRACT_STATES = [
  { code: 'uketsuke', name: '申込受付', initial: true, terminal: false },
  { code: 'keiyaku', name: '契約締結', initial: false, terminal: false },
  { code: 'loan', name: 'ローン審査', initial: false, terminal: false },
  { code: 'kessai', name: '決済', initial: false, terminal: false },
  { code: 'hikiwatashi', name: '引渡し完了', initial: false, terminal: true },
];
export const CONTRACT_ACTIONS = [
  ['締結する', 'uketsuke', 'keiyaku'],
  ['審査へ進める', 'keiyaku', 'loan'],
  ['決済する', 'loan', 'kessai'],
  ['引渡す', 'kessai', 'hikiwatashi'],
];

// ----------------------------------------------------------------- payments
// [code, contractCode, kind, amount, status, dueDate, paidDate, staffKey]
const PAYMENT_ROWS = [
  [5001, 3001, 'baikai', 4580, 'paid', '2026-10-20', '2026-10-19', 'suzuki'],
  [5002, 3001, 'chukai', 151, 'paid', '2026-10-20', '2026-10-19', 'suzuki'],
  [5003, 3001, 'sonota', 38, 'paid', '2026-11-05', '2026-11-04', 'suzuki'],
  [5004, 3002, 'baikai', 4980, 'paid', '2026-11-10', '2026-11-10', 'nakamura'],
  [5005, 3002, 'chukai', 164, 'paid', '2026-11-10', '2026-11-09', 'nakamura'],
  [5006, 3002, 'sonota', 41, 'unpaid', '2026-12-05', '', 'nakamura'],
  [5007, 3003, 'chukai', 119, 'unpaid', '2026-11-20', '', 'sato'],
  [5008, 3003, 'sonota', 300, 'paid', '2026-11-15', '2026-11-15', 'sato'],
  [5009, 3004, 'chukai', 75, 'partial', '2026-11-28', '', 'suzuki'],
  [5010, 3005, 'sonota', 38, 'unpaid', '2026-12-10', '', 'nakamura'],
];
export const PAYMENTS = PAYMENT_ROWS.map(([code, contract, kind, amount, status, due, paid, staff]) => ({
  code: String(code), contract_key: String(contract), kind, amount: String(amount),
  pay_status: status, due_date: due, paid_date: paid, staff: `staff:${staff}`, note: '',
}));
