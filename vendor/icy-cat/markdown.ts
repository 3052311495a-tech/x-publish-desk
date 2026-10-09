// Copyright (c) 2026 Icy-Cat. MIT License; see THIRD_PARTY_NOTICES.md.
// Source: x-article-workspace e2cf726488f662bd041eb1193f95a9a48d90925d
interface XArticleSettings { stripFrontmatter: boolean; useFilenameAsTitle: boolean; }

const FRONTMATTER_PATTERN = /^---\n[\s\S]*?\n---(?:\n|$)\n*/;
const LEADING_HEADING_PATTERN = /^\s*#\s+/m;

export function buildPreviewMarkdown(
	fileBasename: string,
	markdown: string,
	settings: XArticleSettings,
): string {
	let output = markdown.replace(/\r\n/g, "\n");

	if (settings.stripFrontmatter) {
		output = output.replace(FRONTMATTER_PATTERN, "");
	}

	output = output.trim();

	if (settings.useFilenameAsTitle && !LEADING_HEADING_PATTERN.test(output)) {
		output = `# ${fileBasename}\n\n${output}`;
	}

	return output;
}
