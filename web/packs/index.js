// 流程包的畫面元件登記：核心頁面依申請單的 process_type 取用，自己不認得任何流程包的內容。
import * as dataAccess from './data_access.js';
import { scopeEditor } from './data_access_form.js';

export const packs = {
    data_access: { ...dataAccess, scopeEditor },
};

export const packOf = (processType) => packs[processType];
