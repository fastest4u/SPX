import type { LineBotChat } from '../types'

const redactedSecretPrefix = '********'

export function sortLineChatsForTeamSelect(chats: LineBotChat[]): LineBotChat[] {
  return [...chats].sort((left, right) => {
    const leftIsGroup = left.chatMid.toLowerCase().startsWith('c')
    const rightIsGroup = right.chatMid.toLowerCase().startsWith('c')
    if (leftIsGroup !== rightIsGroup) return leftIsGroup ? -1 : 1
    return (left.chatName || left.chatMid).localeCompare(right.chatName || right.chatMid)
  })
}

export function getSelectableLineGroupChats(chats: LineBotChat[]): LineBotChat[] {
  return sortLineChatsForTeamSelect(chats).filter((chat) => chat.chatMid.toLowerCase().startsWith('c'))
}

export function formatLineChatOptionLabel(chat: LineBotChat): string {
  return `${chat.chatName?.trim() || 'ไม่ทราบชื่อ'} (${chat.chatMid.slice(-8)})`
}

export function isRedactedSecretPreview(value: string): boolean {
  return value.startsWith(redactedSecretPrefix)
}

export function isSelectableLineGroupId(value: string, chats: LineBotChat[]): boolean {
  if (!value || isRedactedSecretPreview(value)) return false
  return getSelectableLineGroupChats(chats).some((chat) => chat.chatMid === value)
}
