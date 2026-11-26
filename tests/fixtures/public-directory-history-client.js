const chapters = Array.from({ length: 60 }, (_, index) => ({
  id: `chapter-${String(index).padStart(2, "0")}`,
  title: `Fixture chapter ${index}`,
  body: "Published fixture information for the directory scroll regression.",
}));

export const appBackendKind = "live";
export const appSupabase = {
  async rpc(name, args = {}) {
    // Exercise the layout shrink and delayed ready focus of a real reader.
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (name === "get_public_directory") return { data: { chapters, meetings: [] }, error: null };
    if (name === "get_public_chapter_microsite") {
      const chapter = chapters.find(({ id }) => id === args.p_chapter_code);
      return { data: chapter ? { ...chapter, sections: Array.from({ length: 40 }, (_, index) => ({ id: `section-${index}`, title: `Fixture section ${index}` })), events: [] } : null, error: null };
    }
    throw new Error(`Unexpected fixture RPC ${name}`);
  },
};
export const supabase = appSupabase;
