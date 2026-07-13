const GREEK_LETTERS = new Map([
  ["Α", "\\Alpha"],
  ["Β", "\\Beta"],
  ["Γ", "\\Gamma"],
  ["Δ", "\\Delta"],
  ["Ε", "\\Epsilon"],
  ["Ζ", "\\Zeta"],
  ["Η", "\\Eta"],
  ["Θ", "\\Theta"],
  ["Ι", "\\Iota"],
  ["Κ", "\\Kappa"],
  ["Λ", "\\Lambda"],
  ["Μ", "\\Mu"],
  ["Ν", "\\Nu"],
  ["Ξ", "\\Xi"],
  ["Ο", "\\Omicron"],
  ["Π", "\\Pi"],
  ["Ρ", "\\Rho"],
  ["Σ", "\\Sigma"],
  ["Τ", "\\Tau"],
  ["Υ", "\\Upsilon"],
  ["Φ", "\\Phi"],
  ["Χ", "\\Chi"],
  ["Ψ", "\\Psi"],
  ["Ω", "\\Omega"],
  ["α", "\\alpha"],
  ["β", "\\beta"],
  ["γ", "\\gamma"],
  ["δ", "\\delta"],
  ["ε", "\\epsilon"],
  ["ϵ", "\\epsilon"],
  ["ζ", "\\zeta"],
  ["η", "\\eta"],
  ["θ", "\\theta"],
  ["ϑ", "\\theta"],
  ["ι", "\\iota"],
  ["κ", "\\kappa"],
  ["λ", "\\lambda"],
  ["μ", "\\mu"],
  ["ν", "\\nu"],
  ["ξ", "\\xi"],
  ["ο", "\\omicron"],
  ["π", "\\pi"],
  ["ρ", "\\rho"],
  ["σ", "\\sigma"],
  ["ς", "\\sigma"],
  ["τ", "\\tau"],
  ["υ", "\\upsilon"],
  ["φ", "\\phi"],
  ["ϕ", "\\phi"],
  ["χ", "\\chi"],
  ["ψ", "\\psi"],
  ["ω", "\\omega"]
]);

const MATH_SYMBOLS = new Map([
  ["−", "-"],
  ["–", "-"],
  ["—", "-"],
  ["×", "\\times"],
  ["·", "\\cdot"],
  ["÷", "/"],
  ["±", "\\pm"],
  ["∓", "\\mp"],
  ["≤", "\\le"],
  ["≥", "\\ge"],
  ["≠", "\\ne"],
  ["≈", "\\approx"],
  ["≃", "\\simeq"],
  ["≡", "\\equiv"],
  ["∞", "\\infty"],
  ["√", "\\sqrt"],
  ["∑", "\\sum"],
  ["∏", "\\prod"],
  ["∫", "\\int"],
  ["∂", "\\partial"],
  ["∇", "\\nabla"],
  ["∈", "\\in"],
  ["∉", "\\notin"],
  ["∀", "\\forall"],
  ["∃", "\\exists"],
  ["∅", "\\emptyset"],
  ["∩", "\\cap"],
  ["∪", "\\cup"],
  ["⊂", "\\subset"],
  ["⊃", "\\supset"],
  ["⊆", "\\subseteq"],
  ["⊇", "\\supseteq"],
  ["→", "\\to"],
  ["←", "\\leftarrow"],
  ["↔", "\\leftrightarrow"],
  ["⇒", "\\Rightarrow"],
  ["⇔", "\\Leftrightarrow"],
  ["ℝ", "\\mathbb{R}"],
  ["ℕ", "\\mathbb{N}"],
  ["ℤ", "\\mathbb{Z}"],
  ["ℚ", "\\mathbb{Q}"],
  ["ℂ", "\\mathbb{C}"]
]);

const SUPER_SUB_ALIASES = new Map([
  ["¹", { mode: "sup", value: "1" }],
  ["²", { mode: "sup", value: "2" }],
  ["³", { mode: "sup", value: "3" }],
  ["º", { mode: "sup", value: "0" }],
  ["⁰", { mode: "sup", value: "0" }],
  ["ⁱ", { mode: "sup", value: "i" }],
  ["ⁿ", { mode: "sup", value: "n" }],
  ["⁺", { mode: "sup", value: "+" }],
  ["⁻", { mode: "sup", value: "-" }],
  ["⁼", { mode: "sup", value: "=" }],
  ["⁽", { mode: "sup", value: "(" }],
  ["⁾", { mode: "sup", value: ")" }],
  ["₀", { mode: "sub", value: "0" }],
  ["₁", { mode: "sub", value: "1" }],
  ["₂", { mode: "sub", value: "2" }],
  ["₃", { mode: "sub", value: "3" }],
  ["₄", { mode: "sub", value: "4" }],
  ["₅", { mode: "sub", value: "5" }],
  ["₆", { mode: "sub", value: "6" }],
  ["₇", { mode: "sub", value: "7" }],
  ["₈", { mode: "sub", value: "8" }],
  ["₉", { mode: "sub", value: "9" }],
  ["₊", { mode: "sub", value: "+" }],
  ["₋", { mode: "sub", value: "-" }],
  ["₌", { mode: "sub", value: "=" }],
  ["₍", { mode: "sub", value: "(" }],
  ["₎", { mode: "sub", value: ")" }],
  ["ₐ", { mode: "sub", value: "a" }],
  ["ₑ", { mode: "sub", value: "e" }],
  ["ₕ", { mode: "sub", value: "h" }],
  ["ᵢ", { mode: "sub", value: "i" }],
  ["ⱼ", { mode: "sub", value: "j" }],
  ["ₖ", { mode: "sub", value: "k" }],
  ["ₗ", { mode: "sub", value: "l" }],
  ["ₘ", { mode: "sub", value: "m" }],
  ["ₙ", { mode: "sub", value: "n" }],
  ["ₒ", { mode: "sub", value: "o" }],
  ["ₚ", { mode: "sub", value: "p" }],
  ["ᵣ", { mode: "sub", value: "r" }],
  ["ₛ", { mode: "sub", value: "s" }],
  ["ₜ", { mode: "sub", value: "t" }],
  ["ᵤ", { mode: "sub", value: "u" }],
  ["ᵥ", { mode: "sub", value: "v" }],
  ["ₓ", { mode: "sub", value: "x" }]
]);

const LATEX_PATTERN = /\\(?:alpha|beta|gamma|delta|epsilon|theta|lambda|mu|pi|rho|sigma|tau|phi|omega|frac|sqrt|sum|prod|int|partial|nabla|left|right|begin|end|cdot|times|le|ge|ne|approx|infty|in|mathbb|mathrm)\b|(?:\${1,2}[^$]+\${1,2})/i;
const GREEK_PATTERN = /[\u0370-\u03ff]/u;
const MATH_SYMBOL_PATTERN = /[−–—×·÷±∓≤≥≠≈≃≡∞√∑∏∫∂∇∈∉∀∃∅∩∪⊂⊃⊆⊇→←↔⇒⇔ℝℕℤℚℂ]/u;
const SUPER_SUB_PATTERN = /[¹²³º⁰ⁱⁿ⁺⁻⁼⁽⁾₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₐₑₕᵢⱼₖₗₘₙₒₚᵣₛₜᵤᵥₓ]/u;
const EQUATION_PATTERN = /(?:[A-Za-z0-9)\]}]|\\[a-z]+)\s*(?:=|<=|>=|<|>|\\le|\\ge|\\ne|\\in)\s*(?:[A-Za-z0-9([{]|\\[a-z]+|[-+*/])/i;
const OPERATOR_PATTERN = /(?:(?:[A-Za-z0-9)\]}]|\\[a-z]+)\s*(?:\^|_|[+*/=<>|])\s*(?:[A-Za-z0-9([{]|\\[a-z]+))|(?:(?:[A-Za-z0-9)\]}]|\\[a-z]+)\s+-\s+(?:[A-Za-z0-9([{]|\\[a-z]+))/i;
const ASCII_CONTEXT_PATTERN = /(?:\barg\s*max\b|\bE\s*\[|\bVar\s*\(|\bLet\s*\{|\bfor all\b|\bgiven\b|\bdefine\b|\bwhere\b|\btheta\b|\btau\b|\bbeta\b|\balpha\b|\bR\s*\^?\s*[knp]?\b|\bZ\s*\+|\bq\s*t\s*\(|\bqt\s*\(|\bf\s*n\s*\(|\bx\s*T\b|\bX\s*T\b)/i;
const SET_PATTERN = /\\mathbb\{[RNZQC]\}/;

export function normalizeFormulaSelection(rawText = "") {
  const raw = String(rawText || "").replace(/\r\n?/g, "\n");
  const ruleHits = new Set();
  const normalizedText = normalizeMathText(raw, ruleHits);
  const formulaFragments = detectFormulaFragments(raw, normalizedText);
  const signals = detectSignals(raw, normalizedText);
  const hasFormulaSignals = Boolean(formulaFragments.length || signals.length);
  const notes = buildFormulaNotes({
    hasFormulaSignals,
    normalizedText,
    raw,
    ruleHits,
    signals
  });

  return {
    rawText: raw,
    normalizedText,
    formulaFragments,
    notes,
    signals,
    hasFormulaSignals,
    normalizationRules: [...ruleHits]
  };
}

export function hasFormulaSignals(text = "") {
  return detectSignals(String(text || "")).length > 0;
}

function normalizeMathText(raw, ruleHits = new Set()) {
  let normalized = normalizeSuperSubscripts(raw, ruleHits);
  normalized = normalizeUnicodeTokens(normalized, ruleHits);
  normalized = normalizeAsciiMathAliases(normalized, ruleHits);
  normalized = normalizeFormulaSpacing(normalized);
  normalized = normalizeFormulaIdioms(normalized, ruleHits);
  normalized = normalizeFormulaSpacing(normalized);
  return normalized.trim();
}

function normalizeUnicodeTokens(text, ruleHits) {
  let normalized = "";
  for (const char of text) {
    if (GREEK_LETTERS.has(char)) {
      ruleHits.add("greek-letters");
      normalized += GREEK_LETTERS.get(char);
      continue;
    }
    if (MATH_SYMBOLS.has(char)) {
      ruleHits.add("unicode-math-symbols");
      normalized += MATH_SYMBOLS.get(char);
      continue;
    }
    normalized += char;
  }
  return normalized;
}

function normalizeSuperSubscripts(text, ruleHits) {
  let output = "";
  let mode = "";
  let buffer = "";

  const flush = () => {
    if (!buffer) {
      return;
    }
    ruleHits.add(mode === "sup" ? "unicode-superscript" : "unicode-subscript");
    output += mode === "sup" ? `^${formatScriptValue(buffer)}` : `_${formatScriptValue(buffer)}`;
    buffer = "";
    mode = "";
  };

  for (const char of text) {
    const script = SUPER_SUB_ALIASES.get(char);
    if (!script) {
      flush();
      output += char;
      continue;
    }
    if (mode && mode !== script.mode) {
      flush();
    }
    mode = script.mode;
    buffer += script.value;
  }
  flush();
  return output;
}

function formatScriptValue(value) {
  return value.length === 1 ? value : `{${value}}`;
}

function normalizeAsciiMathAliases(text, ruleHits) {
  let normalized = text;

  normalized = normalized.replace(/\bR\s*\^\s*([A-Za-z0-9]+)\b/g, (_, power) => {
    ruleHits.add("mathbb-sets");
    return `\\mathbb{R}^${power}`;
  });
  normalized = normalized.replace(/\bR\s+([knp])\b/g, (_, power) => {
    ruleHits.add("mathbb-sets");
    return `\\mathbb{R}^${power}`;
  });
  normalized = normalized.replace(/\bZ\s*\+/g, () => {
    ruleHits.add("mathbb-sets");
    return "\\mathbb{Z}_{+}";
  });

  normalized = normalized.replace(/\bbelongs to\b/g, () => {
    ruleHits.add("ascii-math-operators");
    return "\\in";
  });

  return normalized;
}

function normalizeFormulaIdioms(text, ruleHits) {
  let normalized = text;
  const hasTauContext = /\\tau\b|\btau\b|\bq\s*t\s*\(|\bqt\s*\(|\\betat\b|\\beta\s*t\b|\bbeta\s*t\b/i.test(normalized);

  normalized = normalized.replace(/\bf\s+n(?=\s*(?:\(|:))/g, () => {
    ruleHits.add("function-subscript");
    return "f_n";
  });
  normalized = normalized.replace(/\bf_n\s+\(/g, () => {
    ruleHits.add("function-call-spacing");
    return "f_n(";
  });
  normalized = normalized.replace(/\bf_n\(([^)]*)\)\s*=\s*x\s+n\b/g, (_, variable) => {
    ruleHits.add("function-power");
    return `f_n(${variable}) = x^n`;
  });
  normalized = normalized.replace(/\bx\s+n\b(?=(?:\s*(?:,|\.|;|\)|$)))/g, (match, offset, fullText) => {
    const localContext = fullText.slice(Math.max(0, offset - 32), offset + 24);
    if (!/f_n|=\s*$/.test(localContext)) {
      return match;
    }
    ruleHits.add("function-power");
    return "x^n";
  });

  if (hasTauContext) {
    normalized = normalized.replace(/\bq\s*t\s*\(/gi, () => {
      ruleHits.add("tau-subscript");
      return "q_\\tau(";
    });
    normalized = normalized.replace(/\bqt\s*\(/gi, () => {
      ruleHits.add("tau-subscript");
      return "q_\\tau(";
    });
    normalized = normalized.replace(/\bm\s*\\tau\s*\(/g, () => {
      ruleHits.add("tau-subscript");
      return "m_\\tau(";
    });
    normalized = normalized.replace(/\bm\s*t\s*\(/gi, () => {
      ruleHits.add("tau-subscript");
      return "m_\\tau(";
    });
    normalized = normalized.replace(/\\betat\b/g, () => {
      ruleHits.add("tau-subscript");
      return "\\beta_\\tau";
    });
    normalized = normalized.replace(/\\beta\s*t\b/g, () => {
      ruleHits.add("tau-subscript");
      return "\\beta_\\tau";
    });
    normalized = normalized.replace(/\bbeta\s*t\b/gi, () => {
      ruleHits.add("tau-subscript");
      return "beta_tau";
    });
  }

  normalized = normalized.replace(/\b([xX])\s*T\s*(?=(?:\\beta|beta\b|b\b|[A-Za-z]))/g, (_, vector) => {
    ruleHits.add("transpose");
    return `${vector}^T `;
  });
  normalized = normalized.replace(/\b([xX])\s*\^\s*T\s+/g, (_, vector) => `${vector}^T `);
  normalized = normalized.replace(/\b([xX])T(?=\s*(?:\\beta|beta\b|b\b))/g, (_, vector) => {
    ruleHits.add("transpose");
    return `${vector}^T`;
  });

  normalized = normalized.replace(/(\b[A-Za-z]\b|\\(?:theta|tau|beta|alpha))\s*\\in\s*\\mathbb\{R\}\s+([knp])\b/g, (_, variable, power) => {
    ruleHits.add("mathbb-sets");
    return `${variable} \\in \\mathbb{R}^${power}`;
  });
  normalized = normalized.replace(/(\b[A-Za-z]\b|\\(?:theta|tau|beta|alpha))\s*\\in\s*R\s+([knp])\b/g, (_, variable, power) => {
    ruleHits.add("mathbb-sets");
    return `${variable} \\in \\mathbb{R}^${power}`;
  });
  normalized = normalized.replace(/(\b[A-Za-z]\b|\\(?:theta|tau|beta|alpha))\s*\\in\s*R\b/g, (_, variable) => {
    ruleHits.add("mathbb-sets");
    return `${variable} \\in \\mathbb{R}`;
  });
  normalized = normalized.replace(/(\b[A-Za-z]\b|\\(?:theta|tau|beta|alpha))\s*\\in\s*Z\s*\+/g, (_, variable) => {
    ruleHits.add("mathbb-sets");
    return `${variable} \\in \\mathbb{Z}_{+}`;
  });

  normalized = normalized.replace(/\barg\s+max\s+E\s*\[/gi, (match) => {
    ruleHits.add("argmax-spacing");
    return match.replace(/\s+/g, " ").replace(/E\s+\[/i, "E[");
  });

  return normalized;
}

function normalizeFormulaSpacing(text) {
  return String(text || "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\s+([,.;:)\]}])/g, "$1")
    .replace(/([([{])\s+/g, "$1")
    .replace(/\s*\|\s*/g, " | ")
    .replace(/\s*=\s*/g, " = ")
    .replace(/\s*<\s*/g, " < ")
    .replace(/\s*>\s*/g, " > ")
    .replace(/\s*-\s*/g, " - ")
    .replace(/\s*\+\s*/g, " + ")
    .replace(/\s*(\\in|\\le|\\ge|\\ne|\\approx)\s*/g, " $1 ")
    .replace(/\\mathbb\{Z\}_\{\s*\+\s*\}/g, "\\mathbb{Z}_{+}")
    .replace(/\\mathbb\{R\}\s*\^\s*([A-Za-z0-9]+)/g, "\\mathbb{R}^$1")
    .replace(/([A-Za-z]|\\[A-Za-z]+)_\s*\\tau/g, "$1_\\tau")
    .replace(/([A-Za-z]|\\[A-Za-z]+)\^\s*T/g, "$1^T")
    .replace(/\s{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n");
}

function detectFormulaFragments(raw, normalizedText) {
  const rawSegments = splitCandidateFragments(raw);
  const normalizedSegments = splitCandidateFragments(normalizedText);
  const fragments = [];

  for (const [index, rawSegment] of rawSegments.entries()) {
    const normalizedSegment = normalizedSegments[index] || normalizeMathText(rawSegment);
    const signals = detectSignals(rawSegment, normalizedSegment);
    if (!signals.length && !isMathDenseSegment(rawSegment, normalizedSegment)) {
      continue;
    }
    fragments.push({
      raw: rawSegment,
      normalized: normalizedSegment,
      signals
    });
  }

  if (!fragments.length && detectSignals(raw, normalizedText).length) {
    fragments.push({
      raw: clip(raw, 280),
      normalized: clip(normalizedText, 280),
      signals: detectSignals(raw, normalizedText)
    });
  }

  return fragments.slice(0, 8);
}

function splitCandidateFragments(text) {
  const lines = String(text || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const segments = lines.length ? lines : [String(text || "").trim()].filter(Boolean);
  return segments
    .flatMap((segment) => segment.split(/(?<=[。！？;；])\s+/))
    .map((segment) => segment.trim())
    .filter(Boolean)
    .slice(0, 20);
}

function detectSignals(rawText, normalizedText = rawText) {
  const raw = String(rawText || "");
  const normalized = String(normalizedText || "");
  const signals = [];
  if (LATEX_PATTERN.test(raw) || LATEX_PATTERN.test(normalized)) {
    signals.push("latex");
  }
  if (MATH_SYMBOL_PATTERN.test(raw) || SET_PATTERN.test(normalized)) {
    signals.push("unicode-math-symbols");
  }
  if (SUPER_SUB_PATTERN.test(raw)) {
    signals.push("unicode-super-or-subscript");
  }
  if (GREEK_PATTERN.test(raw)) {
    signals.push("greek-letters");
  }
  if (EQUATION_PATTERN.test(raw) || EQUATION_PATTERN.test(normalized)) {
    signals.push("equation-like-text");
  }
  if (OPERATOR_PATTERN.test(raw) || OPERATOR_PATTERN.test(normalized)) {
    signals.push("operator-sequence");
  }
  if (ASCII_CONTEXT_PATTERN.test(raw) || ASCII_CONTEXT_PATTERN.test(normalized)) {
    signals.push("math-text-context");
  }
  return [...new Set(signals)];
}

function isMathDenseSegment(rawText, normalizedText = rawText) {
  const raw = String(rawText || "").trim();
  const normalized = String(normalizedText || "").trim();
  const value = normalized || raw;
  if (value.length < 4) {
    return false;
  }
  const mathChars = (value.match(/[=+\-*/^_<>()[\]{}|]/g) || []).length;
  const letters = (value.match(/[A-Za-z]/g) || []).length;
  return letters >= 1 && (mathChars >= 2 || ASCII_CONTEXT_PATTERN.test(value));
}

function buildFormulaNotes({ hasFormulaSignals, normalizedText, raw, ruleHits, signals }) {
  if (!hasFormulaSignals) {
    return [];
  }

  const notes = [
    "Formula text is derived only from the browser/PDF selectable text layer. StepRead does not run OCR or recognize formula images here.",
    "raw_text is preserved as copied evidence; normalized_text is a conservative helper for AI reading, not a promise of visual LaTeX reconstruction.",
    "If the PDF text layer already lost symbols, reordered tokens, or produced mojibake, this normalizer may not be able to recover the original formula."
  ];

  if (normalizedText !== raw.trim()) {
    notes.push("normalized_text was generated from lightweight symbol, Greek-letter, set, subscript, superscript, transpose, and common econometrics-formula heuristics.");
  }
  if (ruleHits?.size) {
    notes.push(`normalization_rules: ${[...ruleHits].sort().join(", ")}.`);
  }
  if (signals.length) {
    notes.push(`detected_signals: ${signals.join(", ")}.`);
  }
  return notes;
}

function clip(text, maxLength) {
  const value = String(text || "").trim();
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 12)}...[clipped]`;
}
