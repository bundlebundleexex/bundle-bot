import fs from "node:fs/promises";
import path from "node:path";
import { FileBlob, SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const inputPath = "C:/Users/Szymon/Desktop/Steam_GPU_pelna_lista.xlsx";
const outputDir = "C:/Users/Szymon/Desktop/bundle-bot/outputs/01a09158-2517-70b2-8929-c2b4029d385d";
const outputPath = path.join(outputDir, "Steam_GPU_kategorie.xlsx");
const previewPath = path.join(outputDir, "Steam_GPU_kategorie_preview.png");

function normalizeName(value) {
  return String(value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/[™®]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isGpuRow(name, share) {
  const upper = name.toUpperCase();
  return (
    name &&
    Number.isFinite(share) &&
    upper !== "OTHER" &&
    !upper.startsWith("POWYZEJ") &&
    !upper.startsWith("POWYŻEJ")
  );
}

function classifyGpu(name) {
  const upper = normalizeName(name).toUpperCase();

  const rtx = upper.match(/\bRTX\s+([2-5]\d{3})\b/);
  if (rtx) {
    const series = Math.floor(Number(rtx[1]) / 100);
    if (series >= 50) return { tier: 50, label: "RTX 50 / odpowiednik" };
    if (series >= 40) return { tier: 40, label: "RTX 40 / odpowiednik" };
    if (series >= 30) return { tier: 30, label: "RTX 30 / odpowiednik" };
    if (series >= 20) return { tier: 20, label: "RTX 20 / odpowiednik" };
  }

  if (/\bGTX\s+(10|16)\d{2}\b/.test(upper)) {
    return { tier: 10, label: "GTX 10/16 / odpowiednik" };
  }

  const amdRx4 = upper.match(/\bRX\s+([5-9]\d{3})\b/);
  if (amdRx4) {
    const model = Number(amdRx4[1]);
    if (model >= 9000) return { tier: 50, label: "Radeon RX 9000" };
    if (model >= 7000) return { tier: 40, label: "Radeon RX 7000" };
    if (model >= 6000) return { tier: 30, label: "Radeon RX 6000" };
    if (model >= 5000) return { tier: 20, label: "Radeon RX 5000" };
  }

  const amdRx3 = upper.match(/\bRX\s+(\d{3})\b/);
  if (amdRx3) {
    const model = Number(amdRx3[1]);
    if (model >= 570) return { tier: 10, label: "Radeon RX 570/580" };
  }

  if (/\bRADEON\s+780M\b/.test(upper)) {
    return { tier: 10, label: "Radeon 780M" };
  }

  if (/\bINTEL\s+ARC\b/.test(upper)) {
    return { tier: 30, label: "Intel Arc" };
  }

  return { tier: null, label: "Starsze, zintegrowane lub nieokreślone" };
}

function pct(value) {
  return `${(value * 100).toFixed(2)}%`;
}

function columnLetter(index) {
  let n = index + 1;
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

await fs.mkdir(outputDir, { recursive: true });

const sourceBlob = await FileBlob.load(inputPath);
const sourceWorkbook = await SpreadsheetFile.importXlsx(sourceBlob);
const sourceSheet = sourceWorkbook.worksheets.getItem("Steam GPU");
const sourceValues = sourceSheet.getUsedRange().values;

const sourceRows = sourceValues
  .slice(1)
  .map((row, index) => {
    const gpu = normalizeName(row[0]);
    const share = Number(row[1]);
    const classification = classifyGpu(gpu);
    return {
      sourceRow: index + 2,
      gpu,
      share,
      tier: classification.tier,
      tierLabel: classification.label,
    };
  })
  .filter((row) => isGpuRow(row.gpu, row.share));

const categories = [
  {
    key: "all",
    title: "Wszystkie GPU",
    minTier: null,
    note: "Pełna lista realnych GPU z głównej kolumny.",
  },
  {
    key: "gtx10",
    title: "GTX 10/16+ i odpowiedniki",
    minTier: 10,
    note: "GTX 10, GTX 16 oraz nowsze rodziny i porównywalne Radeony.",
  },
  {
    key: "rtx20",
    title: "RTX 20+ i odpowiedniki",
    minTier: 20,
    note: "RTX 20 lub nowsze, Radeon RX 5000+ oraz Intel Arc tam, gdzie pasuje próg.",
  },
  {
    key: "rtx30",
    title: "RTX 30+ i odpowiedniki",
    minTier: 30,
    note: "RTX 30 lub nowsze, Radeon RX 6000+ oraz Intel Arc.",
  },
  {
    key: "rtx40",
    title: "RTX 40+ i odpowiedniki",
    minTier: 40,
    note: "RTX 40 lub nowsze oraz Radeon RX 7000+.",
  },
  {
    key: "rtx50",
    title: "RTX 50+ i odpowiedniki",
    minTier: 50,
    note: "RTX 50 oraz Radeon RX 9000.",
  },
];

const lists = new Map();
for (const category of categories) {
  const rows =
    category.minTier === null
      ? [...sourceRows]
      : sourceRows.filter((row) => row.tier !== null && row.tier >= category.minTier);
  lists.set(category.key, rows);
}

const workbook = Workbook.create();
const summary = workbook.worksheets.add("Kategorie");
const mapping = workbook.worksheets.add("Przypisanie");

summary.showGridLines = false;
mapping.showGridLines = false;
summary.tabColor = "#1F4E78";
mapping.tabColor = "#9CA3AF";

const totalCols = 17;
const dataStartRow = 8;
const maxListLength = Math.max(...categories.map((category) => lists.get(category.key).length));
const summaryRows = dataStartRow + maxListLength + 2;

summary.mergeCells("A1:Q1");
summary.mergeCells("A2:Q2");
summary.mergeCells("A3:Q3");
summary.getRange("A1").values = [["Steam GPU - podział według progów"]];
summary.getRange("A2").values = [[
  "Źródło: główna lista z arkusza Steam GPU. Pominięto wiersz Other oraz istniejące wiersze podsumowań POWYZEJ.",
]];
summary.getRange("A3").values = [[
  "Reguła: progi są przypisane po rodzinie modelu/generacji, a nie po dokładnych benchmarkach pojedynczych kart.",
]];

const tableMatrix = Array.from({ length: maxListLength }, () => Array(totalCols).fill(null));

for (const [idx, category] of categories.entries()) {
  const startCol = idx * 3;
  const startLetter = columnLetter(startCol);
  const endLetter = columnLetter(startCol + 1);
  const rows = lists.get(category.key);
  const totalShare = rows.reduce((sum, row) => sum + row.share, 0);

  summary.mergeCells(`${startLetter}5:${endLetter}5`);
  summary.getRange(`${startLetter}5`).values = [[category.title]];
  summary.getRange(`${startLetter}6:${endLetter}8`).values = [
    ["Liczba GPU", rows.length],
    ["Suma udziału", totalShare],
    ["GPU", "Udział"],
  ];

  for (let rowIdx = 0; rowIdx < rows.length; rowIdx += 1) {
    tableMatrix[rowIdx][startCol] = rows[rowIdx].gpu;
    tableMatrix[rowIdx][startCol + 1] = rows[rowIdx].share;
  }
}

summary.getRangeByIndexes(dataStartRow, 0, maxListLength, totalCols).values = tableMatrix;

const fontFamily = "Arial";
summary.getRangeByIndexes(0, 0, summaryRows, totalCols).format.font = {
  name: fontFamily,
  size: 10,
  color: "#111827",
};
summary.getRange("A1").format.font = { name: fontFamily, size: 14, bold: true, color: "#111827" };
summary.getRange("A2:A3").format.font = { name: fontFamily, size: 9, italic: true, color: "#374151" };
summary.getRange("A5:Q5").format = {
  fill: "#1F4E78",
  font: { name: fontFamily, size: 10, bold: true, color: "#FFFFFF" },
  horizontalAlignment: "center",
  verticalAlignment: "center",
};
summary.getRange("A6:Q7").format = {
  fill: "#EAF2F8",
  font: { name: fontFamily, size: 10, bold: false, color: "#111827" },
  verticalAlignment: "center",
};
summary.getRange("A8:Q8").format = {
  fill: "#374151",
  font: { name: fontFamily, size: 10, bold: true, color: "#FFFFFF" },
  horizontalAlignment: "center",
  verticalAlignment: "center",
};
summary.getRangeByIndexes(dataStartRow, 0, maxListLength, totalCols).format = {
  verticalAlignment: "center",
  wrapText: false,
};

for (const [idx] of categories.entries()) {
  const startCol = idx * 3;
  const endCol = startCol + 1;
  const nameLetter = columnLetter(startCol);
  const shareLetter = columnLetter(endCol);
  const spacerLetter = columnLetter(startCol + 2);
  summary.getRangeByIndexes(0, startCol, summaryRows, 1).format.columnWidth = 38;
  summary.getRangeByIndexes(0, endCol, summaryRows, 1).format.columnWidth = 11;
  summary.getRange(`${shareLetter}7`).format.numberFormat = "0.00%";
  summary.getRange(`${shareLetter}9:${shareLetter}${8 + maxListLength}`).format.numberFormat = "0.00%";
  summary.getRange(`${nameLetter}5:${shareLetter}${8 + maxListLength}`).format.borders = {
    preset: "outside",
    style: "thin",
    color: "#B7C9D9",
  };
  if (startCol + 2 < totalCols) {
    summary.getRangeByIndexes(0, startCol + 2, summaryRows, 1).format.columnWidth = 3;
    summary.getRange(`${spacerLetter}1:${spacerLetter}${summaryRows}`).format.fill = "#FFFFFF";
  }
}

summary.freezePanes.freezeRows(8);

const mappingRows = [
  ["GPU", "Udział", "Minimalny próg", "Przypisanie", "Wiersz źródłowy"],
  ...sourceRows.map((row) => [
    row.gpu,
    row.share,
    row.tier === null ? "Nieujęte w progach" : row.tier === 10 ? "GTX 10/16+" : `RTX ${row.tier}+`,
    row.tierLabel,
    row.sourceRow,
  ]),
];
mapping.getRangeByIndexes(0, 0, mappingRows.length, mappingRows[0].length).values = mappingRows;
mapping.getRange("A1:E1").format = {
  fill: "#374151",
  font: { name: fontFamily, size: 10, bold: true, color: "#FFFFFF" },
  horizontalAlignment: "center",
  verticalAlignment: "center",
};
mapping.getRangeByIndexes(0, 0, mappingRows.length, mappingRows[0].length).format.font = {
  name: fontFamily,
  size: 10,
  color: "#111827",
};
mapping.getRange(`B2:B${mappingRows.length}`).format.numberFormat = "0.00%";
mapping.getRangeByIndexes(0, 0, mappingRows.length, mappingRows[0].length).format.borders = {
  preset: "outside",
  style: "thin",
  color: "#D1D5DB",
};
mapping.getRangeByIndexes(0, 0, mappingRows.length, 1).format.columnWidth = 42;
mapping.getRangeByIndexes(0, 1, mappingRows.length, 1).format.columnWidth = 11;
mapping.getRangeByIndexes(0, 2, mappingRows.length, 1).format.columnWidth = 20;
mapping.getRangeByIndexes(0, 3, mappingRows.length, 1).format.columnWidth = 34;
mapping.getRangeByIndexes(0, 4, mappingRows.length, 1).format.columnWidth = 13;
mapping.freezePanes.freezeRows(1);
mapping.tables.add(`A1:E${mappingRows.length}`, true, "GpuMapping");

workbook.recalculate();

const summaryInspect = await workbook.inspect({
  kind: "table",
  range: "Kategorie!A1:Q18",
  include: "values,formulas",
  tableMaxRows: 18,
  tableMaxCols: 17,
  maxChars: 8000,
});
console.log(summaryInspect.ndjson);

const errorScan = await workbook.inspect({
  kind: "match",
  searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A|#NUM!|#NULL!|#SPILL!|#CALC!",
  options: { useRegex: true, maxResults: 300 },
  summary: "final formula error scan",
  maxChars: 4000,
});
console.log(errorScan.ndjson);

const preview = await workbook.render({
  sheetName: "Kategorie",
  range: "A1:Q35",
  scale: 1,
  format: "png",
});
await fs.writeFile(previewPath, new Uint8Array(await preview.arrayBuffer()));

const exported = await SpreadsheetFile.exportXlsx(workbook);
await exported.save(outputPath);

console.log(
  JSON.stringify(
    {
      outputPath,
      previewPath,
      counts: Object.fromEntries(
        categories.map((category) => [
          category.title,
          {
            rows: lists.get(category.key).length,
            share: pct(lists.get(category.key).reduce((sum, row) => sum + row.share, 0)),
            note: category.note,
          },
        ]),
      ),
    },
    null,
    2,
  ),
);
