import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  crossrefSearchJournalTitles: vi.fn(),
  crossrefWork: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ({
  crossrefSearchJournalTitles: mocks.crossrefSearchJournalTitles,
  crossrefWork: mocks.crossrefWork,
}));

import { searchDocxCitationArticles } from "./docx-citation-search";

const response = (items: unknown[]) => JSON.stringify({ message: { items } });

const completeArticle = {
  DOI: "10.1000/example#result",
  title: ["A <i>measured</i> result &amp; its limit"],
  author: [
    { given: "Ada", family: "Lovelace" },
    { family: "Turing" },
  ],
  issued: { "date-parts": [[2024, 2]] },
  "container-title": ["Journal of <i>Tests</i>"],
  type: "journal-article",
  volume: "12",
  issue: "3",
  page: "41-59",
};

beforeEach(() => {
  mocks.crossrefSearchJournalTitles.mockReset();
  mocks.crossrefWork.mockReset();
});

describe("searchDocxCitationArticles", () => {
  it("maps validated journal metadata without combining author fields", async () => {
    mocks.crossrefSearchJournalTitles.mockResolvedValue(response([completeArticle]));

    await expect(searchDocxCitationArticles("measured results")).resolves.toEqual([{
      title: "A measured result & its limit",
      journal: "Journal of Tests",
      authors: [
        { family: "Lovelace", given: "Ada" },
        { family: "Turing" },
      ],
      year: "2024",
      volume: "12",
      issue: "3",
      pages: "41-59",
      url: "https://doi.org/10.1000/example%23result",
    }]);
    expect(mocks.crossrefSearchJournalTitles).toHaveBeenCalledWith("measured results");
    expect(mocks.crossrefWork).not.toHaveBeenCalled();
  });

  it.each(["10.1000/EXAMPLE#RESULT", "doi: 10.1000/example#result", "https://doi.org/10.1000/example%23result", "dx.doi.org/10.1000/example%23result"])(
    "looks up %s by exact DOI, without title search",
    async (query) => {
      mocks.crossrefWork.mockResolvedValue(completeArticle);

      await expect(searchDocxCitationArticles(query)).resolves.toEqual([
        expect.objectContaining({ title: "A measured result & its limit", url: "https://doi.org/10.1000/example%23result" }),
      ]);
      expect(mocks.crossrefWork).toHaveBeenCalledExactlyOnceWith("10.1000/example#result");
      expect(mocks.crossrefSearchJournalTitles).not.toHaveBeenCalled();
    },
  );

  it.each([null, { ...completeArticle, DOI: "10.1000/another" }, { ...completeArticle, type: "book-chapter" }])(
    "offers no substitute when the exact DOI has no usable matching record",
    async (record) => {
      mocks.crossrefWork.mockResolvedValue(record);
      await expect(searchDocxCitationArticles("10.1000/example#result")).resolves.toEqual([]);
      expect(mocks.crossrefSearchJournalTitles).not.toHaveBeenCalled();
    },
  );

  it("omits optional metadata that Crossref does not return", async () => {
    mocks.crossrefSearchJournalTitles.mockResolvedValue(response([{
      DOI: "not a DOI",
      title: "Plain title",
      author: [{ family: "Hopper" }],
      issued: { "date-parts": [["1985"]] },
      "container-title": "A Journal",
      type: "journal-article",
      volume: "",
      issue: " ",
      page: "",
    }]));

    const articles = await searchDocxCitationArticles("plain title");

    expect(articles).toEqual([{
      title: "Plain title",
      journal: "A Journal",
      authors: [{ family: "Hopper" }],
      year: "1985",
    }]);
    expect(articles[0]).not.toHaveProperty("url");
  });

  it("drops non-journal and incomplete or non-person author records", async () => {
    mocks.crossrefSearchJournalTitles.mockResolvedValue(response([
      { ...completeArticle, type: "book-chapter" },
      { ...completeArticle, title: [] },
      { ...completeArticle, "container-title": [] },
      { ...completeArticle, issued: { "date-parts": [["2024-02-01"]] } },
      { ...completeArticle, author: [] },
      { ...completeArticle, author: [{ name: "A Consortium" }] },
      { ...completeArticle, author: [{ given: "Only" }] },
      {
        title: ["Kept article"],
        author: [{ family: "Lovelace", given: "Ada" }],
        issued: { "date-parts": [[2023]] },
        "container-title": ["Kept Journal"],
        type: "journal-article",
      },
    ]));

    await expect(searchDocxCitationArticles("mixed records")).resolves.toEqual([{
      title: "Kept article",
      journal: "Kept Journal",
      authors: [{ family: "Lovelace", given: "Ada" }],
      year: "2023",
    }]);
  });

  it.each(["", "<html>rate limited</html>", "{}", '{"message":{"items":{}}}'])(
    "returns no articles for an unreadable response (%s)",
    async (payload) => {
      mocks.crossrefSearchJournalTitles.mockResolvedValue(payload);

      await expect(searchDocxCitationArticles("query")).resolves.toEqual([]);
    },
  );

  it("preserves transport failures for the caller", async () => {
    const failure = new Error("Crossref returned HTTP 503.");
    mocks.crossrefSearchJournalTitles.mockRejectedValue(failure);

    await expect(searchDocxCitationArticles("query")).rejects.toBe(failure);
  });
});
