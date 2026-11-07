package dev.golem.phone

import android.Manifest
import android.content.ContentProviderOperation
import android.content.ContentResolver
import android.content.res.Resources
import android.net.Uri
import android.provider.ContactsContract
import android.provider.ContactsContract.CommonDataKinds.Email
import android.provider.ContactsContract.CommonDataKinds.Event
import android.provider.ContactsContract.CommonDataKinds.Organization
import android.provider.ContactsContract.CommonDataKinds.Phone as PhoneNumber
import android.provider.ContactsContract.CommonDataKinds.StructuredName
import android.provider.ContactsContract.CommonDataKinds.StructuredPostal
import android.provider.ContactsContract.Contacts
import android.provider.ContactsContract.Data
import android.provider.ContactsContract.RawContacts
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable

/** The phone's contacts (`ContactsContract`). A contact's id is its lookup key, which stays when its accounts sync. */
object PhoneContacts {
    @Serializable
    private data class FindArguments(val query: String)

    @Serializable
    private data class ContactArguments(
        val id: String? = null,
        val givenName: String? = null,
        val familyName: String? = null,
        val organization: String? = null,
        val phones: List<NewPhone>? = null,
        val emails: List<NewEmail>? = null,
        val birthday: String? = null,
    )

    @Serializable
    private data class NewPhone(val number: String, val label: String? = null)

    @Serializable
    private data class NewEmail(val address: String, val label: String? = null)

    @Serializable
    private data class Labeled(val label: String, val value: String)

    @Serializable
    private data class Row(
        val id: String,
        val name: String,
        val organization: String,
        val phones: List<Labeled>,
        val emails: List<Labeled>,
        val addresses: List<Labeled>,
        val birthday: String? = null,
    )

    suspend fun find(phone: Phone): PhoneAnswer {
        val query = phone.arguments<FindArguments>().query
        access(phone)
        val resolver = phone.context.contentResolver
        val ids = withContext(Dispatchers.IO) {
            resolver.query(
                Uri.withAppendedPath(Contacts.CONTENT_FILTER_URI, Uri.encode(query)), arrayOf(Contacts._ID), null, null, null,
            )?.use { cursor -> cursor.rows { cursor.getLong(0) } }.orEmpty().take(50)
        }
        return jsonAnswer(rows(resolver, ids, phone.context.resources))
    }

    suspend fun add(phone: Phone): PhoneAnswer {
        val arguments = phone.arguments<ContactArguments>()
        arguments.birthday?.let(::birthday)
        access(phone)
        val resolver = phone.context.contentResolver
        val operations = arrayListOf(
            // No account: the contact stays on the phone, or goes to the account that the phone makes the default.
            ContentProviderOperation.newInsert(RawContacts.CONTENT_URI)
                .withValue(RawContacts.ACCOUNT_TYPE, null).withValue(RawContacts.ACCOUNT_NAME, null).build()
        )
        fun insert(mime: String, vararg values: Pair<String, Any?>) {
            operations += ContentProviderOperation.newInsert(Data.CONTENT_URI).withValueBackReference(Data.RAW_CONTACT_ID, 0)
                .withValue(Data.MIMETYPE, mime).apply { values.forEach { (key, value) -> withValue(key, value) } }.build()
        }
        if (arguments.givenName != null || arguments.familyName != null) {
            insert(StructuredName.CONTENT_ITEM_TYPE, StructuredName.GIVEN_NAME to arguments.givenName,
                StructuredName.FAMILY_NAME to arguments.familyName)
        }
        arguments.organization?.let { insert(Organization.CONTENT_ITEM_TYPE, Organization.COMPANY to it) }
        arguments.birthday?.let { insert(Event.CONTENT_ITEM_TYPE, Event.START_DATE to it, Event.TYPE to Event.TYPE_BIRTHDAY) }
        details(arguments).forEach { (mime, values) -> insert(mime, *values.toList().toTypedArray()) }
        val contactId = withContext(Dispatchers.IO) {
            val raw = resolver.applyBatch(ContactsContract.AUTHORITY, operations)[0].uri
                ?: throw PhoneError("Contacts did not save the contact.")
            resolver.query(raw, arrayOf(RawContacts.CONTACT_ID), null, null, null)?.use { if (it.moveToFirst()) it.getLong(0) else null }
                ?: throw PhoneError("Contacts did not save the contact.")
        }
        return jsonAnswer(rows(resolver, listOf(contactId), phone.context.resources).first())
    }

    suspend fun change(phone: Phone): PhoneAnswer {
        val arguments = phone.arguments<ContactArguments>()
        arguments.birthday?.let(::birthday)
        access(phone)
        val resolver = phone.context.contentResolver
        val id = arguments.id.orEmpty()
        return withContext(Dispatchers.IO) {
            val contactId = resolver.query(
                Uri.withAppendedPath(Contacts.CONTENT_LOOKUP_URI, Uri.encode(id)), arrayOf(Contacts._ID), null, null, null,
            )?.use { if (it.moveToFirst()) it.getLong(0) else null } ?: throw PhoneError("There is no contact $id.")
            val rawId = resolver.query(
                RawContacts.CONTENT_URI, arrayOf(RawContacts._ID), "${RawContacts.CONTACT_ID} = ? AND ${RawContacts.DELETED} = 0",
                arrayOf(contactId.toString()), null,
            )?.use { if (it.moveToFirst()) it.getLong(0) else null } ?: throw PhoneError("There is no contact $id.")
            val operations = ArrayList<ContentProviderOperation>()
            fun set(mime: String, extra: String?, vararg values: Pair<String, Any?>) {
                val selection = "${Data.RAW_CONTACT_ID} = ? AND ${Data.MIMETYPE} = ?" + (extra?.let { " AND $it" } ?: "")
                val selected = arrayOf(rawId.toString(), mime)
                val exists = resolver.query(Data.CONTENT_URI, arrayOf(Data._ID), selection, selected, null)?.use { it.count > 0 } == true
                operations += if (exists) {
                    ContentProviderOperation.newUpdate(Data.CONTENT_URI).withSelection(selection, selected)
                } else {
                    ContentProviderOperation.newInsert(Data.CONTENT_URI).withValue(Data.RAW_CONTACT_ID, rawId).withValue(Data.MIMETYPE, mime)
                }.apply { values.forEach { (key, value) -> withValue(key, value) } }.build()
            }
            val names = listOfNotNull(
                arguments.givenName?.let { StructuredName.GIVEN_NAME to it },
                arguments.familyName?.let { StructuredName.FAMILY_NAME to it },
            )
            if (names.isNotEmpty()) set(StructuredName.CONTENT_ITEM_TYPE, null, *names.toTypedArray())
            arguments.organization?.let { set(Organization.CONTENT_ITEM_TYPE, null, Organization.COMPANY to it) }
            arguments.birthday?.let {
                set(Event.CONTENT_ITEM_TYPE, "${Event.TYPE} = ${Event.TYPE_BIRTHDAY}", Event.START_DATE to it, Event.TYPE to Event.TYPE_BIRTHDAY)
            }
            details(arguments).forEach { (mime, values) ->
                operations += ContentProviderOperation.newInsert(Data.CONTENT_URI).withValue(Data.RAW_CONTACT_ID, rawId)
                    .withValue(Data.MIMETYPE, mime).apply { values.forEach { (key, value) -> withValue(key, value) } }.build()
            }
            resolver.applyBatch(ContactsContract.AUTHORITY, operations)
            jsonAnswer(rows(resolver, listOf(contactId), phone.context.resources).first())
        }
    }

    /** The phone and email rows to add, by their kind. */
    private fun details(arguments: ContactArguments): List<Pair<String, Map<String, Any?>>> =
        arguments.phones.orEmpty().map { phone ->
            val (type, label) = phoneType(phone.label)
            PhoneNumber.CONTENT_ITEM_TYPE to mapOf(PhoneNumber.NUMBER to phone.number, PhoneNumber.TYPE to type, PhoneNumber.LABEL to label)
        } + arguments.emails.orEmpty().map { email ->
            val (type, label) = emailType(email.label)
            Email.CONTENT_ITEM_TYPE to mapOf(Email.ADDRESS to email.address, Email.TYPE to type, Email.LABEL to label)
        }

    /** The type of a phone number's label, and the label itself when Android has no type for it. */
    fun phoneType(label: String?): Pair<Int, String?> = when (label?.lowercase()) {
        null, "mobile", "iphone", "cell" -> PhoneNumber.TYPE_MOBILE to null
        "home" -> PhoneNumber.TYPE_HOME to null
        "work" -> PhoneNumber.TYPE_WORK to null
        "main" -> PhoneNumber.TYPE_MAIN to null
        "other" -> PhoneNumber.TYPE_OTHER to null
        else -> PhoneNumber.TYPE_CUSTOM to label
    }

    fun emailType(label: String?): Pair<Int, String?> = when (label?.lowercase()) {
        "home" -> Email.TYPE_HOME to null
        "work" -> Email.TYPE_WORK to null
        "mobile" -> Email.TYPE_MOBILE to null
        null, "other" -> Email.TYPE_OTHER to null
        else -> Email.TYPE_CUSTOM to label
    }

    /** A birthday as Android keeps it: `YYYY-MM-DD`, or `--MM-DD` without a year. */
    fun birthday(text: String): String {
        if (!Regex("""(\d{4}|-)-\d{2}-\d{2}""").matches(text)) throw PhoneError("birthday must be YYYY-MM-DD or --MM-DD.")
        return text
    }

    private suspend fun rows(resolver: ContentResolver, ids: List<Long>, resources: Resources): List<Row> = withContext(Dispatchers.IO) {
        if (ids.isEmpty()) return@withContext emptyList()
        val contacts = resolver.query(
            Contacts.CONTENT_URI, arrayOf(Contacts._ID, Contacts.LOOKUP_KEY, Contacts.DISPLAY_NAME),
            "${Contacts._ID} IN (${ids.joinToString(",")})", null, null,
        )?.use { cursor -> cursor.rows { cursor.getLong(0) to (cursor.getString(1).orEmpty() to cursor.getString(2).orEmpty()) } }
            .orEmpty().toMap()
        val data = resolver.query(
            Data.CONTENT_URI, arrayOf(Data.CONTACT_ID, Data.MIMETYPE, Data.DATA1, Data.DATA2, Data.DATA3),
            "${Data.CONTACT_ID} IN (${ids.joinToString(",")})", null, null,
        )?.use { cursor ->
            cursor.rows { DataRow(cursor.getLong(0), cursor.getString(1).orEmpty(), cursor.getString(2), cursor.getInt(3), cursor.getString(4)) }
        }.orEmpty().groupBy { it.contact }
        ids.mapNotNull { id ->
            val (lookup, name) = contacts[id] ?: return@mapNotNull null
            val rows = data[id].orEmpty()
            fun labeled(mime: String, label: (DataRow) -> CharSequence) =
                rows.filter { it.mime == mime && it.value != null }.map { Labeled(label(it).toString(), it.value!!) }
            Row(
                id = lookup,
                name = name,
                organization = rows.firstOrNull { it.mime == Organization.CONTENT_ITEM_TYPE }?.value.orEmpty(),
                phones = labeled(PhoneNumber.CONTENT_ITEM_TYPE) { PhoneNumber.getTypeLabel(resources, it.type, it.label) },
                emails = labeled(Email.CONTENT_ITEM_TYPE) { Email.getTypeLabel(resources, it.type, it.label) },
                addresses = labeled(StructuredPostal.CONTENT_ITEM_TYPE) { StructuredPostal.getTypeLabel(resources, it.type, it.label) }
                    .map { it.copy(value = it.value.replace("\n", ", ")) },
                birthday = rows.firstOrNull { it.mime == Event.CONTENT_ITEM_TYPE && it.type == Event.TYPE_BIRTHDAY }?.value
                    ?.let { Regex("""^(\d{4}|-)-\d{2}-\d{2}""").find(it)?.value },
            )
        }
    }

    /** A data row of a contact: `value` is DATA1, `type` DATA2, and `label` DATA3, as the common kinds use them. */
    private data class DataRow(val contact: Long, val mime: String, val value: String?, val type: Int, val label: String?)

    private suspend fun access(phone: Phone) =
        phone.allow("Contacts", Manifest.permission.READ_CONTACTS, Manifest.permission.WRITE_CONTACTS)
}
