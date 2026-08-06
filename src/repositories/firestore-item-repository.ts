import type { AppConfig } from "../config/env.js";
import type { Item } from "../domain/item.js";
import type { ItemRepository, SaveItemInput } from "../ports/item-repository.js";
import { getFirestore } from "../services/auth/firebase-auth-service.js";

export class FirestoreItemRepository implements ItemRepository {
  private readonly firestore: FirebaseFirestore.Firestore;

  constructor(config: AppConfig) {
    this.firestore = getFirestore(config);
  }

  async save(input: SaveItemInput): Promise<Item> {
    const now = new Date().toISOString();
    const docRef = this.firestore.collection("users").doc(input.uid).collection("items").doc(input.itemId);
    const debugDocRef = this.firestore.collection("users").doc(input.uid).collection("item_debug").doc(input.itemId);

    return this.firestore.runTransaction(async (transaction) => {
      const debugSnapshot = await transaction.get(debugDocRef);
      const debugData = debugSnapshot.exists ? (debugSnapshot.data() as { audit?: { idempotencyKey?: string } }) : null;

      const existingSnapshot = await transaction.get(docRef);
      if (existingSnapshot.exists) {
        const existing = existingSnapshot.data() as Item;
        if (debugData?.audit?.idempotencyKey === input.audit.idempotencyKey) {
          return existing;
        }

        const updated: Item = {
          ...existing,
          title: input.title,
          summary: input.summary,
          category: input.category,
          deadline: input.deadline,
          eventDate: input.eventDate,
          state: input.state,
          metadata: input.metadata,
          updatedAt: now
        };
        transaction.set(docRef, updated);
        transaction.set(debugDocRef, {
          itemId: input.itemId,
          uid: input.uid,
          audit: input.audit,
          updatedAt: now
        });
        return updated;
      }

      const item: Item = {
        id: input.itemId,
        title: input.title,
        summary: input.summary,
        category: input.category,
        deadline: input.deadline,
        eventDate: input.eventDate,
        state: input.state,
        metadata: input.metadata,
        createdAt: now,
        updatedAt: now
      };
      transaction.set(docRef, item);
      transaction.set(debugDocRef, {
        itemId: input.itemId,
        uid: input.uid,
        audit: input.audit,
        updatedAt: now
      });
      return item;
    });
  }
}
