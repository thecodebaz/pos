// Contrato único entre a UI e o sqlite.worker.ts.
// Este ficheiro não contém código de persistência: apenas tipos e constantes.
export const UNIT_LABELS = {
    un: "Unidade",
    kg: "Quilograma",
    g: "Grama",
    l: "Litro",
    ml: "Mililitro",
    cx: "Caixa",
    pct: "Pacote",
};
export const PAYMENT_LABELS = {
    cash: "Dinheiro",
    card: "Cartão",
    pos: "POS",
    mpesa: "M-Pesa",
    emola: "e-Mola",
    transfer: "Transferência",
    other: "Outro",
};
export const EXPENSE_CATEGORIES = [
    "compras",
    "transporte",
    "utilidades",
    "salarios",
    "aluguer",
    "manutencao",
    "impostos",
    "marketing",
    "outros",
];
export const EXPENSE_CATEGORY_LABELS = {
    compras: "Compras e mercadorias",
    transporte: "Transporte",
    utilidades: "Luz, água e internet",
    salarios: "Salários",
    aluguer: "Aluguer",
    manutencao: "Manutenção",
    impostos: "Impostos e taxas",
    marketing: "Marketing",
    outros: "Outros",
};
export const ROLE_LABELS = {
    owner: "Proprietário",
    manager: "Gerente",
    cashier: "Caixa",
};
export function isWorkerResponse(value) {
    return (typeof value === "object" &&
        value !== null &&
        typeof value.id === "string" &&
        typeof value.ok === "boolean");
}
