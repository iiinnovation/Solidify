/**
 * DeliverableContract registry
 * @module lib/engine/deliverables/registry
 */

import type { DeliverableContract } from './types'
import { defaultTextContract } from './text'
import { drawioContract } from './drawio'

export class DeliverableContractRegistry {
  private contracts = new Map<string, DeliverableContract>()

  constructor() {
    this.register(defaultTextContract)
    this.register(drawioContract)
  }

  register(contract: DeliverableContract): void {
    this.contracts.set(contract.id, contract)
  }

  get(id?: string): DeliverableContract {
    if (!id) return defaultTextContract
    const contract = this.contracts.get(id)
    if (!contract) throw new Error(`Unknown deliverable contract: ${id}`)
    return contract
  }

  has(id: string): boolean {
    return this.contracts.has(id)
  }
}

export const deliverableRegistry = new DeliverableContractRegistry()
