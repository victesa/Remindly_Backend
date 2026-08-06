import type { Item, ItemAudit } from "../domain/item.js";

export interface SaveItemInput extends Omit<Item, "id" | "createdAt" | "updatedAt"> {
  uid: string;
  itemId: string;
  audit: ItemAudit;
}

export interface ItemRepository {
  save(input: SaveItemInput): Promise<Item>;
}
