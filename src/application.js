import { PublicationStore } from "./publications.js";
import { TopicalStore } from "./store.js";

export class TopicalApplication {
  #initialized = false;

  constructor({ root, publicationRoots = {}, store, publications } = {}) {
    this.store = store || new TopicalStore(root);
    this.publications = publications || new PublicationStore({
      topicalRoot: root,
      publicationRoots,
      topicStore: this.store
    });
  }

  async initialize() {
    if (this.#initialized) return this;
    await this.store.initialize();
    try {
      await this.publications.initialize();
    } catch (error) {
      await this.store.close();
      throw error;
    }
    this.#initialized = true;
    return this;
  }

  async close() {
    await this.store.close();
    this.#initialized = false;
  }

  searchTopics(input) { return this.store.searchTopics(input); }
  listTopics(input) { return this.store.listTopics(input); }
  listTags(input) { return this.store.listTags(input); }
  listHistory(input) { return this.store.listHistory(input); }
  getSystemHealth() { return this.store.getSystemHealth(); }
  createTopic(input) { return this.store.createTopic(input); }
  readTopicFile(input) { return this.store.readTopicFile(input); }
  getTopicOverview(input) { return this.store.getTopicOverview(input); }
  updateTopicFile(input) { return this.store.updateTopicFile(input); }
  createTopicFile(input) { return this.store.createTopicFile(input); }
  deleteTopicFile(input) { return this.store.deleteTopicFile(input); }
  updateTopicMetadata(input) { return this.store.updateTopicMetadata(input); }
  deleteTopic(input) { return this.store.deleteTopic(input); }
  listTrash(input) { return this.store.listTrash(input); }
  restoreTrash(input) { return this.store.restoreTrash(input); }
  reindex() { return this.store.reindex(); }
  publishDocument(input) { return this.publications.publishDocument(input); }
  listPublications(input) { return this.publications.listPublications(input); }
  getPublicationStatus(input) { return this.publications.getPublicationStatus(input); }
  readPublication(input) { return this.publications.readPublication(input); }
  updatePublication(input) { return this.publications.updatePublication(input); }
  forgetPublication(input) { return this.publications.forgetPublication(input); }
}
